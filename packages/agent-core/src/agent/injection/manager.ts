import type { Agent } from '..';
import type { DynamicInjector } from './injector';
import { GoalInjector } from './goal';
import { PermissionModeInjector } from './permission-mode';
import { PluginSessionStartInjector } from './plugin-session-start';
import { PlanModeInjector } from './plan-mode';
import { TodoListReminderInjector } from './todo-list';
import { WolfPackModeInjector } from './wolfpack';
import { WorkingSetInjector } from './working-set';

const VARIANT_TITLES: Record<string, string> = {
  'working-set': 'Working Set',
  'goal': 'Goal',
  'todo_list_reminder': 'Todo List',
  'wolfpack': 'WolfPack Mode',
  'plan_mode': 'Plan Mode',
  'permission_mode': 'Permission Mode',
  'plugin_session_start': 'Plugin Session Start',
};

function sectionTitle(variant: string): string {
  return VARIANT_TITLES[variant] ?? variant;
}

export class InjectionManager {
  private readonly injectors: DynamicInjector[];

  constructor(protected readonly agent: Agent) {
    this.injectors = [
      new PluginSessionStartInjector(agent),
      new WolfPackModeInjector(agent),
      new PlanModeInjector(agent),
      new PermissionModeInjector(agent),
      new TodoListReminderInjector(agent),
      new GoalInjector(agent),
      new WorkingSetInjector(agent),
    ];
  }

  async inject(): Promise<void> {
    const parts: { variant: string; content: string; injector: DynamicInjector }[] = [];

    for (const injector of this.injectors) {
      const injection = await injector.collectInjection();
      if (injection !== undefined) {
        parts.push({ variant: injector['injectionVariant'], content: injection, injector });
      }
    }

    if (parts.length === 0) return;

    const merged = parts
      .map((p, i) => {
        const title = sectionTitle(p.variant);
        return `## ${title}\n\n${p.content}`;
      })
      .join('\n\n---\n\n');

    const historyLen = this.agent.context.history.length;
    this.agent.context.appendSystemReminder(merged, {
      kind: 'injection',
      variant: 'composite',
    });

    for (const part of parts) {
      part.injector.markInjected(historyLen);
    }
  }

  /** Reset per-turn state on all injectors. */
  resetForTurn(): void {
    // No-op: none of the current injectors maintain per-turn state.
  }

  onContextClear(): void {
    for (const injector of this.injectors) {
      injector.onContextClear();
    }
  }

  onContextCompacted(compactedCount: number): void {
    for (const injector of this.injectors) {
      try {
        injector.onContextCompacted(compactedCount);
      } catch {
        continue;
      }
    }
  }

  onContextMessageRemoved(index: number): void {
    for (const injector of this.injectors) {
      try {
        injector.onContextMessageRemoved(index);
      } catch {
        continue;
      }
    }
  }
}
