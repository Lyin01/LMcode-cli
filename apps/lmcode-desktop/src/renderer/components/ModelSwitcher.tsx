import { useState, useEffect, useCallback } from 'react'
import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import { ChevronDown, Check, Cpu } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useSessionStore } from '@/stores/session-store'
import { useConfigStore } from '@/stores/config-store'

interface ModelEntry {
  id: string
  label: string
  provider: string
}

export function ModelSwitcher() {
  const model = useSessionStore((s) => s.model)
  const currentSessionId = useSessionStore((s) => s.currentSessionId)
  const config = useConfigStore((s) => s.config)
  const [models, setModels] = useState<ModelEntry[]>([])
  const [open, setOpen] = useState(false)

  useEffect(() => {
    if (!config) return
    const entries: ModelEntry[] = []

    if (config.models && typeof config.models === 'object') {
      for (const [id, alias] of Object.entries(config.models as Record<string, any>)) {
        entries.push({
          id,
          label: alias.displayName || alias.model || id,
          provider: alias.provider || '',
        })
      }
    }

    if (entries.length === 0 && config.providers && typeof config.providers === 'object') {
      for (const [providerId, provider] of Object.entries(config.providers as Record<string, any>)) {
        if (provider.defaultModel) {
          entries.push({
            id: `${providerId}:${provider.defaultModel}`,
            label: `${provider.defaultModel}`,
            provider: providerId,
          })
        }
      }
    }

    if (config.defaultModel && !entries.some((e) => e.id === config.defaultModel)) {
      entries.push({ id: config.defaultModel as string, label: config.defaultModel as string, provider: '' })
    }

    entries.sort((a, b) => a.label.localeCompare(b.label))
    setModels(entries)
  }, [config])

  const handleSelect = useCallback(
    async (modelId: string) => {
      if (!currentSessionId) return
      try {
        await window.lmcodeAPI.setModel(currentSessionId, modelId)
        useSessionStore.getState().updateSessionStatus({ model: modelId })
      } catch (err) {
        console.error('Failed to set model:', err)
      }
      setOpen(false)
    },
    [currentSessionId],
  )

  // Before the first turn the session model is unknown; fall back to the
  // configured default so the composer shows the active model immediately.
  const effectiveModel = model || (config?.defaultModel as string) || ''

  if (models.length === 0 && !effectiveModel) return null

  const currentLabel =
    models.find((m) => m.id === effectiveModel)?.label || effectiveModel || '选择模型'

  return (
    <DropdownMenu.Root open={open} onOpenChange={setOpen}>
      <DropdownMenu.Trigger asChild>
        <button
          className="flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[12px] font-medium text-[var(--lm-text-secondary)] transition-colors hover:bg-[var(--lm-bg-hover)] hover:text-[var(--lm-text-primary)]"
          title="切换模型"
        >
          <Cpu size={14} className="text-[var(--lm-text-muted)]" />
          <span className="max-w-[150px] truncate">{currentLabel}</span>
          <ChevronDown
            size={13}
            className={cn('text-[var(--lm-text-muted)] transition-transform', open && 'rotate-180')}
          />
        </button>
      </DropdownMenu.Trigger>

      <DropdownMenu.Portal>
        <DropdownMenu.Content
          side="top"
          align="start"
          sideOffset={6}
          className="z-50 min-w-[200px] max-w-[300px] overflow-hidden rounded-xl border border-[var(--lm-border)] bg-[var(--lm-bg-elevated)] shadow-[var(--lm-shadow-pop)]"
        >
          <div className="border-b border-[var(--lm-border)] px-3 py-1.5 text-[10px] font-medium uppercase tracking-wider text-[var(--lm-text-muted)]">
            模型
          </div>
          <div className="max-h-[280px] overflow-y-auto p-1">
            {models.length === 0 && (
              <div className="px-3 py-4 text-center text-[12px] text-[var(--lm-text-muted)]">
                未配置模型
              </div>
            )}
            {models.map((entry) => (
              <DropdownMenu.Item
                key={entry.id}
                onSelect={() => handleSelect(entry.id)}
                className={cn(
                  'flex cursor-pointer items-center gap-2 rounded-lg px-2.5 py-2 text-[13px] outline-none transition-colors',
                  'data-[highlighted]:bg-[var(--lm-bg-hover)]',
                  effectiveModel === entry.id ? 'text-[var(--lm-text-primary)]' : 'text-[var(--lm-text-secondary)]',
                )}
              >
                <div className="flex min-w-0 flex-col">
                  <span className={cn('truncate', effectiveModel === entry.id && 'font-medium')}>
                    {entry.label}
                  </span>
                  {entry.provider && (
                    <span className="text-[10px] text-[var(--lm-text-muted)]">{entry.provider}</span>
                  )}
                </div>
                {effectiveModel === entry.id && (
                  <Check size={14} className="ml-auto shrink-0 text-[var(--lm-accent-text)]" />
                )}
              </DropdownMenu.Item>
            ))}
          </div>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  )
}
