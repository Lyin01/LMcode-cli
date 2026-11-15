import { greeting } from '@/lib/greeting'

/**
 * Empty state: a serif greeting on paper, no logo block. Claude opens a
 * conversation with a sentence, not a badge; the product name is redundant
 * here because it is already in the sidebar.
 */
export function AgentWelcome() {
  return (
    <div data-ui="welcome" className="mb-7 flex flex-col items-center text-center animate-fade-in">
      <h2
        className="text-[30px] leading-[1.25] tracking-[-0.015em] text-[var(--lm-text-primary)]"
        style={{ fontFamily: 'var(--lm-font-serif)', fontWeight: 400 }}
      >
        {greeting()}，今天想做什么？
      </h2>
      <p className="mt-2.5 max-w-md text-[12.5px] leading-relaxed text-[var(--lm-text-muted)]">
        LMCODE · 智能工程 AI Agent
      </p>
    </div>
  )
}
