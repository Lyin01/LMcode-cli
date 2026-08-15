import { greeting } from '@/lib/greeting'
import { Sparkles } from 'lucide-react'

export function AgentWelcome() {
  return (
    <div className="mb-8 flex flex-col items-center text-center animate-fade-in">
      <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-2xl bg-gradient-to-tr from-[#4176E6] to-[#679EFE] text-white shadow-[0_8px_24px_rgba(65,118,230,0.3)]">
        <Sparkles size={22} className="animate-pulse" />
      </div>
      <h2 className="text-[26px] font-semibold leading-tight tracking-tight text-[var(--lm-text-primary)]">
        {greeting()}，今天想做什么？
      </h2>
      <p className="mt-2 max-w-md text-[13px] leading-relaxed text-[var(--lm-text-muted)]">
        LMCODE · 智能工程 AI Agent
      </p>
    </div>
  )
}
