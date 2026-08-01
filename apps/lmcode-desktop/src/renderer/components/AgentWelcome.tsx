import { greeting } from '@/lib/greeting'

export function AgentWelcome() {
  return (
    <div className="mb-8 flex flex-col items-center text-center">
      <div className="mb-4 flex h-11 w-11 items-center justify-center rounded-[14px] border border-[var(--lm-border)] bg-[var(--lm-bg-surface)] text-[17px] font-semibold tracking-tight text-[var(--lm-text-primary)] shadow-sm">
        L
      </div>
      <h2 className="text-[28px] font-semibold leading-tight tracking-[-0.025em] text-[var(--lm-text-primary)]">
        {greeting()}，今天要推进什么？
      </h2>
      <p className="mt-2 max-w-md text-[12px] leading-relaxed text-[var(--lm-text-muted)]">
        描述目标，LMCODE 会在所选工作区中规划、执行并验证结果。
      </p>
    </div>
  )
}
