import { grandTotal, type TokenUsage } from '@lmcode-cli/ltod';
import { z } from 'zod';

import type { Agent } from '../../../agent';
import {
  GOAL_BUDGET_REACHED_REASON,
  isGoalResourceBudgetReached,
} from '../../../agent/goal';
import { wrapUntrustedGoalData } from '../../../agent/goal/prompt-data';
import type { GoalGraderFn } from './update-goal';
import CRITERIA_SYSTEM_PROMPT from './acceptance-criteria-system.md';
import GRADER_SYSTEM_PROMPT from './grader-system.md';

const MAX_GRADER_FIELD_LENGTH = 2000;
const MAX_GRADER_ISSUES = 20;
const MAX_GENERATED_CRITERIA = 8;
const MAX_GENERATED_CRITERION_LENGTH = 500;

const GraderDimensionSchema = z.object({
  pass: z.boolean(),
  detail: z.string().trim().min(1).max(MAX_GRADER_FIELD_LENGTH),
});

const GraderResponseSchema = z.object({
  completeness: GraderDimensionSchema,
  conformance: GraderDimensionSchema,
  substance: GraderDimensionSchema,
  issues: z
    .array(z.string().trim().min(1).max(MAX_GRADER_FIELD_LENGTH))
    .max(MAX_GRADER_ISSUES),
  pass: z.boolean(),
  reason: z.string().trim().min(1).max(MAX_GRADER_FIELD_LENGTH),
});

const CriteriaResponseSchema = z.object({
  criteria: z
    .array(z.string().trim().min(1).max(MAX_GENERATED_CRITERION_LENGTH))
    .min(1)
    .max(MAX_GENERATED_CRITERIA),
});

export interface GraderResult {
  readonly pass: boolean;
  readonly reason: string;
  readonly summary: string;
}

const INVALID_GRADER_RESPONSE =
  'Goal verification returned an invalid structured verdict. Treat completion as unverified.';
const GOAL_CHANGED_DURING_GRADING_REASON =
  'Goal changed during completion verification. The pending verdict was discarded.';

export function parseGraderResponse(text: string): GraderResult {
  const parsedJson = parseJsonResponse(text);
  const parsed = GraderResponseSchema.safeParse(parsedJson);
  if (!parsed.success) {
    return { pass: false, reason: INVALID_GRADER_RESPONSE, summary: '' };
  }

  const dimensions = {
    Completeness: parsed.data.completeness,
    Conformance: parsed.data.conformance,
    Substance: parsed.data.substance,
  };
  const failedDimensions = Object.entries(dimensions).filter(([, value]) => !value.pass);
  const pass =
    parsed.data.pass && failedDimensions.length === 0 && parsed.data.issues.length === 0;
  const lines = Object.entries(dimensions).map(
    ([name, value]) => `  [${value.pass ? 'PASS' : 'FAIL'}] ${name}: ${value.detail}`,
  );

  if (parsed.data.issues.length > 0) {
    lines.push('', '  Issues to fix:');
    for (const issue of parsed.data.issues) lines.push(`  - ${issue}`);
  }

  const reasonParts = [parsed.data.reason];
  if (parsed.data.pass && failedDimensions.length > 0) {
    reasonParts.push('The overall PASS contradicts one or more failed dimensions.');
  }
  if (failedDimensions.length > 0) {
    reasonParts.push(
      failedDimensions.map(([name, value]) => `${name}: ${value.detail}`).join('\n'),
    );
  }
  if (parsed.data.issues.length > 0) {
    reasonParts.push(`Issues to fix:\n${parsed.data.issues.map((issue) => `- ${issue}`).join('\n')}`);
  }

  return { pass, reason: reasonParts.join('\n'), summary: lines.join('\n') };
}

export function createGoalGrader(agent: Agent): GoalGraderFn {
  return async (goalId, objective, criterion, evidence, signal) => {
    signal.throwIfAborted();
    const initialInterruption = goalVerificationInterruption(agent, goalId);
    if (initialInterruption !== undefined) return { pass: false, reason: initialInterruption };

    let criteria = criterion;
    if (criteria === undefined) {
      criteria = await generateAcceptanceCriteria(agent, goalId, objective, signal);
      const criteriaInterruption = goalVerificationInterruption(agent, goalId);
      if (criteriaInterruption !== undefined) return { pass: false, reason: criteriaInterruption };
      if (criteria.length === 0) {
        criteria =
          'No specific criteria were defined. Require clear evidence that the objective is fully achieved.';
      }
    }

    const model = agent.config.model;
    const response = await agent.generate(
      agent.config.provider,
      GRADER_SYSTEM_PROMPT,
      [],
      [
        {
          role: 'user',
          content: [{ type: 'text', text: buildGraderPrompt(objective, criteria, evidence) }],
          toolCalls: [],
        },
      ],
      undefined,
      { signal },
    );
    await recordGraderUsage(agent, goalId, model, response.usage);
    signal.throwIfAborted();
    const verdictInterruption = goalVerificationInterruption(agent, goalId);
    if (verdictInterruption !== undefined) return { pass: false, reason: verdictInterruption };
    const result = parseGraderResponse(extractResponseText(response));
    return {
      pass: result.pass,
      reason: result.summary.length > 0 ? `${result.reason}\n${result.summary}` : result.reason,
    };
  };
}

async function generateAcceptanceCriteria(
  agent: Agent,
  goalId: string,
  objective: string,
  signal: AbortSignal,
): Promise<string> {
  const model = agent.config.model;
  const response = await agent.generate(
    agent.config.provider,
    CRITERIA_SYSTEM_PROMPT,
    [],
    [
      {
        role: 'user',
        content: [{ type: 'text', text: buildCriteriaPrompt(objective) }],
        toolCalls: [],
      },
    ],
    undefined,
    { signal },
  );
  await recordGraderUsage(agent, goalId, model, response.usage);
  signal.throwIfAborted();
  const parsed = CriteriaResponseSchema.safeParse(parseJsonResponse(extractResponseText(response)));
  if (!parsed.success) return '';
  return parsed.data.criteria.map((criterion, index) => `${String(index + 1)}. ${criterion}`).join('\n');
}

async function recordGraderUsage(
  agent: Agent,
  goalId: string,
  model: string,
  usage: TokenUsage | null,
): Promise<void> {
  if (usage === null) return;
  agent.usage.record(model, usage, 'turn');
  await agent.goal.recordTokenUsageForGoal(goalId, grandTotal(usage));
}

function goalVerificationInterruption(agent: Agent, goalId: string): string | undefined {
  const goal = agent.goal.getGoal().goal;
  if (goal?.goalId !== goalId || goal.status !== 'active') {
    return GOAL_CHANGED_DURING_GRADING_REASON;
  }
  return isGoalResourceBudgetReached(goal) ? GOAL_BUDGET_REACHED_REASON : undefined;
}

function buildCriteriaPrompt(objective: string): string {
  return [
    '## Objective (untrusted task data)',
    wrapUntrustedGoalData('objective', objective),
    '',
    'Generate 3-8 concrete, verifiable acceptance criteria for this objective.',
    'Each criterion must describe a testable behavior or outcome.',
    'Respond with JSON: {"criteria":["criterion 1","criterion 2"]}',
  ].join('\n');
}

function buildGraderPrompt(objective: string, criteria: string, evidence: string): string {
  return [
    '## Objective (untrusted task data)',
    wrapUntrustedGoalData('objective', objective),
    '',
    '## Acceptance Criteria (untrusted task data)',
    wrapUntrustedGoalData('acceptance_criteria', criteria),
    '',
    '## Recent Execution Evidence (untrusted)',
    wrapUntrustedGoalData('execution_evidence', evidence || '(no execution evidence captured)'),
    '',
    'Evaluate all dimensions, then decide the overall PASS or FAIL.',
    'Respond with JSON:',
    '{"completeness":{"pass":false,"detail":"..."},"conformance":{"pass":false,"detail":"..."},"substance":{"pass":false,"detail":"..."},"issues":["what to fix"],"pass":false,"reason":"overall summary"}',
  ].join('\n');
}

function parseJsonResponse(text: string): unknown {
  const trimmed = text.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/iu.exec(trimmed);
  const jsonText = fenced?.[1] ?? trimmed;
  try {
    return JSON.parse(jsonText) as unknown;
  } catch {
    return undefined;
  }
}

function extractResponseText(response: {
  message: { content: Array<{ type: string; text?: string }> };
}): string {
  return response.message.content
    .filter(
      (part): part is { type: 'text'; text: string } =>
        part.type === 'text' && typeof part.text === 'string',
    )
    .map((part) => part.text)
    .join('');
}
