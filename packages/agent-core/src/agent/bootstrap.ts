/**
 * Anchored Bootstrap — first-request trajectory anchoring for DeepSeek-family
 * models, modeled after xiaobright/dsh-anchored-standard.
 *
 * DeepSeek official models condition their reasoning trajectory ("we"-style
 * anchored thinking vs "Let me first…" filler) on the API-visible tool catalog
 * and the auto-injected workspace/skill context of the FIRST model request.
 * This component keeps the first request on a Minimal-style surface — a small
 * tool subset (default Bash + Read/Write/Edit, the lmcode mapping of the dsh
 * Minimal pair `bash` + `str_replace_editor`) and no injected session context
 * (the AGENTS.md + skill-catalog digest) — then promotes to the full catalog
 * and restored context once the session has produced its first durable
 * promotion signal (a tool call OR the first assistant reply, whichever comes
 * first; `promoteOn` selects the trigger).
 *
 * The phase is derived from DURABLE context history, so resume and reload
 * preserve it: a resumed session that already replied or called a tool stays
 * promoted, while an interrupted-before-first-response session re-anchors.
 *
 * Robustness (mirrors the dsh preset):
 *  - Only the main agent participates; subagents always see the full catalog.
 *  - A missing bootstrap tool degrades to the full catalog with a one-time
 *    warning instead of sending the model a zero-tool request.
 *  - Any failure in this filter degrades to the full surface — a bootstrap
 *    bug must never brick a session or eat user context.
 */

import type { Message } from '@lmcode-cli/ltod';

import type { Agent } from '.';
import type { ContextMessage } from './context';
import { project } from './context/projector';
import type { ExecutableTool } from '../loop';

/** Default first-request tool subset: the lmcode Minimal pair (shell + file tools). */
export const DEFAULT_BOOTSTRAP_TOOLS: readonly string[] = ['Bash', 'Read', 'Write', 'Edit'];

/** Default injection variants filtered from the first request while unpromoted.
 *  `session_context` is the single message that carries the AGENTS.md digest,
 *  the skill catalog, and the cwd/date environment — exactly the automatic
 *  injections the dsh reproduction measured as decisive. */
export const DEFAULT_SUPPRESSED_VARIANTS: readonly string[] = ['session_context'];

export type AnchoredPromoteOn = 'tool-call' | 'assistant-message' | 'either';

const PROMOTE_TOOL = 'tool-call';
const PROMOTE_ASSISTANT = 'assistant-message';
const PROMOTE_EITHER = 'either';

interface ResolvedBootstrapConfig {
  readonly enabled: boolean;
  readonly bootstrapTools: readonly string[];
  readonly promoteOn: AnchoredPromoteOn;
  readonly suppressContext: boolean;
  readonly suppressedVariants: readonly string[];
}

export class AnchoredBootstrap {
  private warnedOnce = false;

  constructor(private readonly agent: Agent) {}

  /** Resolve config with defaults; never throws. */
  private resolve(): ResolvedBootstrapConfig {
    const source = this.agent.lmcodeConfig?.anchoredBootstrap;
    const config = source === undefined || typeof source !== 'object' ? {} : source;
    const providers = Array.isArray(config.providers) ? config.providers : [];
    const providerName = this.providerName();
    const enabled =
      config.enabled === true || (providers.length > 0 && providerName !== undefined && providers.includes(providerName));
    return {
      enabled,
      bootstrapTools:
        Array.isArray(config.bootstrapTools) && config.bootstrapTools.length > 0
          ? config.bootstrapTools
          : DEFAULT_BOOTSTRAP_TOOLS,
      promoteOn: config.promoteOn ?? PROMOTE_EITHER,
      suppressContext: config.suppressContext === true,
      suppressedVariants:
        Array.isArray(config.suppressedVariants) && config.suppressedVariants.length > 0
          ? config.suppressedVariants
          : DEFAULT_SUPPRESSED_VARIANTS,
    };
  }

  private providerName(): string | undefined {
    try {
      return this.agent.config?.provider?.name;
    } catch {
      // Provider resolution can fail before a model is configured; treat as
      // "no provider" so auto-match stays off rather than throwing.
      return undefined;
    }
  }

  /** Whether the anchoring filter is active for this agent's next request. */
  isEnabled(): boolean {
    return this.agent.type === 'main' && this.resolve().enabled;
  }

  /**
   * Whether the session has produced its first durable promotion signal.
   * Derived from context history (persisted and replayed on resume).
   *
   * The open step's empty assistant placeholder (created at `step.begin`,
   * content/toolCalls both empty) never counts, so the very first request is
   * always unpromoted and every later request is promoted once the first
   * response streamed content or a tool call.
   */
  isPromoted(): boolean {
    if (!this.isEnabled()) return true;
    const { promoteOn } = this.resolve();
    const wantsTool = promoteOn === PROMOTE_TOOL || promoteOn === PROMOTE_EITHER;
    const wantsAssistant = promoteOn === PROMOTE_ASSISTANT || promoteOn === PROMOTE_EITHER;
    for (const message of this.agent.context.history) {
      if (message.role === 'tool') {
        if (wantsTool) return true;
        continue;
      }
      if (message.role !== 'assistant') continue;
      const hasContent = message.content.length > 0;
      const hasToolCalls = message.toolCalls.length > 0;
      if (wantsAssistant && hasContent) return true;
      if (wantsTool && hasToolCalls) return true;
    }
    return false;
  }

  /** Whether the current request should still be filtered (tools + context). */
  isFiltering(): boolean {
    return this.isEnabled() && !this.isPromoted();
  }

  /**
   * Tool catalog for the current request. Unpromoted: only the bootstrap
   * subset; promoted / disabled / subagent: the full catalog.
   *
   * `turnTools` is the turn-start snapshot taken by the turn loop — the loop
   * captures the catalog once per turn (mid-turn tool-set changes apply to the
   * next turn), while this filter is evaluated per request so a mid-turn
   * promotion still unlocks the full turn-start catalog from request #2.
   */
  resolvedTools(turnTools?: readonly ExecutableTool[]): readonly ExecutableTool[] {
    try {
      if (!this.isFiltering()) return turnTools ?? this.agent.tools.loopTools;
      const allowed = new Set(this.resolve().bootstrapTools);
      const available = turnTools ?? this.agent.tools.loopTools;
      const filtered = available.filter((tool) => allowed.has(tool.name));
      // A composition drift that leaves none of the bootstrap tools available
      // must not send the model a zero-tool request: degrade to the full
      // catalog with a one-time warning.
      if (filtered.length === 0) {
        this.warnOnce(
          `anchored-bootstrap: none of the bootstrap tools are available (wanted=${JSON.stringify([...allowed])}); falling back to the full catalog`,
        );
        return available;
      }
      return filtered;
    } catch (error) {
      this.warnOnce(
        `anchored-bootstrap: tool filter failed, exposing the full catalog: ${String((error && (error as Error).message) || error)}`,
      );
      return turnTools ?? this.agent.tools.loopTools;
    }
  }

  /**
   * Conversation messages for the current request. Unpromoted and
   * `suppressContext`: the session context (AGENTS.md + skill catalog digest)
   * is filtered before projection; otherwise identical to `context.messages`.
   */
  messages(): Message[] {
    try {
      if (!this.isFiltering() || !this.resolve().suppressContext) {
        return this.agent.context.messages;
      }
      const suppressed = new Set(this.resolve().suppressedVariants);
      const history = this.agent.context.history.filter(
        (message) => !this.isSuppressed(message, suppressed),
      );
      this.agent.microCompaction.detect();
      return project(this.agent.microCompaction.compact(history));
    } catch (error) {
      // A filter bug must never eat the user's context: degrade to keeping
      // every message.
      this.warnOnce(
        `anchored-bootstrap: context filter failed, keeping injected context: ${String((error && (error as Error).message) || error)}`,
      );
      return this.agent.context.messages;
    }
  }

  private isSuppressed(message: ContextMessage, suppressed: ReadonlySet<string>): boolean {
    const origin = message.origin;
    if (origin === undefined || origin.kind !== 'injection') return false;
    return typeof origin.variant === 'string' && suppressed.has(origin.variant);
  }

  private warnOnce(message: string): void {
    if (this.warnedOnce) return;
    this.warnedOnce = true;
    try {
      this.agent.log?.warn(message);
    } catch {
      // Logger unavailable — the guard exists only to avoid spamming.
    }
  }
}
