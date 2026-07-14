import { z } from 'zod';

import type { Agent } from '../../../agent';
import type { GoalGraderFn } from './update-goal';
import CRITERIA_SYSTEM_PROMPT from './acceptance-criteria-system.md';
import GRADER_SYSTEM_PROMPT from './grader-system.md';

const GraderDimensionSchema = z.object({
  pass: z.boolean(),
  detail: z.string().min(1),
});

const GraderResponseSchema = z.object({
  completeness: GraderDimensionSchema,
  conformance: GraderDimensionSchema,
  substance: GraderDimensionSchema,
  issues: z.array(z.string()),
  pass: z.boolean(),
  reason: z.string().min(1),
});

const CriteriaResponseSchema = z.object({
  criteria: z.array(z.string().min(1)).min(1),
});

export interface GraderResult {
  readonly pass: boolean;
  readonly reason: string;
  readonly summary: string;
}

const INVALID_GRADER_RESPONSE =
  'Goal verification returned an invalid structured verdict. Treat completion as unverified.';

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
  return async (objective, criterion, output, signal) => {
    let criteria = criterion;
    if (criteria === undefined) {
      criteria = await generateAcceptanceCriteria(agent, objective, signal);
      if (criteria.length === 0) {
        criteria =
          'No specific criteria were defined. Require clear evidence that the objective is fully achieved.';
      }
    }

    const response = await agent.generate(
      agent.config.provider,
      GRADER_SYSTEM_PROMPT,
      [],
      [
        {
          role: 'user',
          content: [{ type: 'text', text: buildGraderPrompt(objective, criteria, output) }],
          toolCalls: [],
        },
      ],
      undefined,
      { signal },
    );
    const result = parseGraderResponse(extractResponseText(response));
    return {
      pass: result.pass,
      reason: result.summary.length > 0 ? `${result.reason}\n${result.summary}` : result.reason,
    };
  };
}

async function generateAcceptanceCriteria(
  agent: Agent,
  objective: string,
  signal: AbortSignal,
): Promise<string> {
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
  const parsed = CriteriaResponseSchema.safeParse(parseJsonResponse(extractResponseText(response)));
  if (!parsed.success) return '';
  return parsed.data.criteria.map((criterion, index) => `${String(index + 1)}. ${criterion}`).join('\n');
}

function buildCriteriaPrompt(objective: string): string {
  return [
    '## Objective',
    objective,
    '',
    'Generate 3-8 concrete, verifiable acceptance criteria for this objective.',
    'Each criterion must describe a testable behavior or outcome.',
    'Respond with JSON: {"criteria":["criterion 1","criterion 2"]}',
  ].join('\n');
}

function buildGraderPrompt(objective: string, criteria: string, output: string): string {
  return [
    '## Objective',
    objective,
    '',
    '## Acceptance Criteria',
    criteria,
    '',
    '## Agent Output',
    output || '(no output captured)',
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
