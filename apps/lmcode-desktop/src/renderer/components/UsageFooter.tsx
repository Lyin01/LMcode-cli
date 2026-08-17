import { useCallback, useEffect, useRef, useState } from 'react'
import { Gauge, RefreshCw, WalletCards } from 'lucide-react'
import { useSessionStore } from '@/stores/session-store'
import {
  buildOpenCodeUsageDisplay,
  buildProviderUsageDisplay,
  formatQuotaResetTime,
  type OpenCodeQuotaMeter,
} from '@/lib/provider-usage'
import { cn } from '@/lib/utils'
import type { ProviderUsageSnapshot } from '../../shared/provider-usage-types'

const REFRESH_INTERVAL_MS = 60_000

function quotaFillClass(remainingPercent: number | null): string {
  if (remainingPercent === null) return 'bg-[var(--lm-text-muted)]'
  if (remainingPercent <= 10) return 'bg-[var(--lm-error)]'
  if (remainingPercent <= 25) return 'bg-[var(--lm-warning)]'
  return 'bg-[var(--lm-accent)]'
}

function quotaMeterTitle(meter: OpenCodeQuotaMeter): string {
  const percent = meter.remainingPercent === null ? '未知' : `${String(meter.remainingPercent)}%`
  const reset = meter.resetAt === undefined
    ? '未提供重置时间'
    : `重置于 ${formatQuotaResetTime(meter.resetAt)}`
  return `${meter.label}额度：剩余 ${String(meter.remaining)} / ${String(meter.limit)}（${percent}）\n${reset}`
}

function QuotaMeter({ meter }: { readonly meter: OpenCodeQuotaMeter }) {
  const percent = meter.remainingPercent
  const title = quotaMeterTitle(meter)
  return (
    <div
      role="group"
      className="flex h-7 min-w-0 items-center gap-1.5 rounded-md px-1.5 transition-colors hover:bg-[var(--lm-bg-hover)]"
      title={title}
      aria-label={title}
    >
      <span className="w-7 shrink-0 text-[10px] font-medium text-[var(--lm-text-secondary)]">
        {meter.label}
      </span>
      <span
        aria-hidden="true"
        className="h-1.5 min-w-8 flex-1 overflow-hidden rounded-full bg-[var(--lm-bg-active)]"
      >
        <span
          className={cn('block h-full rounded-full transition-[width] duration-300', quotaFillClass(percent))}
          style={{ width: `${String(percent ?? 0)}%` }}
        />
      </span>
      <span
        className={cn(
          'w-8 shrink-0 text-right text-[10px] font-semibold tabular-nums',
          percent !== null && percent <= 10
            ? 'text-[var(--lm-error)]'
            : percent !== null && percent <= 25
              ? 'text-[var(--lm-warning)]'
              : 'text-[var(--lm-text-secondary)]',
        )}
      >
        {percent === null ? '—' : `${String(percent)}%`}
      </span>
    </div>
  )
}

function formatFetchedAt(fetchedAt: number): string {
  if (!Number.isFinite(fetchedAt)) return '—'
  return new Date(fetchedAt).toLocaleTimeString('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
  })
}

export function UsageFooter() {
  const isStreaming = useSessionStore((state) => state.isStreaming)
  const [snapshot, setSnapshot] = useState<ProviderUsageSnapshot | null>(null)
  const [loading, setLoading] = useState(true)
  const [ipcError, setIpcError] = useState<string | null>(null)
  const mountedRef = useRef(false)
  const requestIdRef = useRef(0)
  const previousStreamingRef = useRef(isStreaming)

  const refresh = useCallback(async (force: boolean) => {
    const requestId = ++requestIdRef.current
    setLoading(true)
    try {
      const next = await window.lmcodeAPI.getProviderUsage(force)
      if (!mountedRef.current || requestId !== requestIdRef.current) return
      setSnapshot(next)
      setIpcError(null)
    } catch (error) {
      if (!mountedRef.current || requestId !== requestIdRef.current) return
      const message = error instanceof Error ? error.message : String(error)
      setIpcError(message)
    } finally {
      if (mountedRef.current && requestId === requestIdRef.current) setLoading(false)
    }
  }, [])

  useEffect(() => {
    mountedRef.current = true
    void refresh(false)
    const timer = window.setInterval(() => void refresh(false), REFRESH_INTERVAL_MS)
    return () => {
      mountedRef.current = false
      window.clearInterval(timer)
    }
  }, [refresh])

  useEffect(() => {
    const wasStreaming = previousStreamingRef.current
    previousStreamingRef.current = isStreaming
    if (wasStreaming && !isStreaming) void refresh(false)
  }, [isStreaming, refresh])

  const display = snapshot === null ? null : buildProviderUsageDisplay(snapshot)
  const openCode = snapshot === null ? null : buildOpenCodeUsageDisplay(snapshot)
  const title = ipcError === null
    ? display?.title ?? '正在查询账户用量'
    : `刷新失败：${ipcError}${display === null ? '' : `\n${display.title}`}`
  const healthy =
    ipcError === null && openCode !== null && openCode.meters.length > 0 && openCode.issue === null

  return (
    <footer
      data-lm-global-usage="true"
      aria-label="OpenCode 订阅额度"
      className="relative z-[60] flex h-[var(--lm-global-usage-height)] w-full shrink-0 items-center gap-2 border-t border-[var(--lm-border)] bg-[var(--lm-bg-sidebar)] px-3 text-[10px] text-[var(--lm-text-muted)]"
      title={title}
    >
      <div className="flex w-[116px] shrink-0 items-center gap-2">
        <Gauge size={13} className="text-[var(--lm-accent-text)]" aria-hidden="true" />
        <span className="font-semibold text-[var(--lm-text-primary)]">OpenCode Go</span>
        <span
          aria-hidden="true"
          className={cn(
            'h-1.5 w-1.5 rounded-full',
            healthy
              ? 'bg-[var(--lm-success)]'
              : openCode?.issue !== null && openCode?.issue !== undefined
                ? 'bg-[var(--lm-warning)]'
                : 'bg-[var(--lm-text-muted)]',
          )}
        />
      </div>

      <div className="h-4 w-px shrink-0 bg-[var(--lm-border)]" aria-hidden="true" />

      <div className="flex min-w-0 flex-1 items-center" role="status" aria-live="polite">
        {snapshot === null ? (
          <span className={ipcError === null ? undefined : 'text-[var(--lm-error)]'}>
            {ipcError === null ? '正在读取订阅额度…' : '额度查询失败'}
          </span>
        ) : openCode === null ? (
          <span>未配置 OpenCode Go 订阅</span>
        ) : openCode.meters.length === 0 ? (
          <span className={openCode.issue === null ? undefined : 'text-[var(--lm-warning)]'}>
            {openCode.issue === null ? '未返回可显示的额度' : 'OpenCode 额度查询失败'}
          </span>
        ) : (
          <div className="grid w-full max-w-[520px] grid-cols-3 gap-1">
            {openCode.meters.slice(0, 3).map((meter) => (
              <QuotaMeter key={meter.label} meter={meter} />
            ))}
          </div>
        )}
      </div>

      {display !== null && (
        <div
          className={cn(
            'hidden min-w-0 max-w-[280px] items-center gap-1.5 border-l border-[var(--lm-border)] pl-3 min-[1180px]:flex',
            display.apiHasIssues && 'text-[var(--lm-warning)]',
          )}
        >
          <WalletCards size={12} className="shrink-0" aria-hidden="true" />
          <span className="truncate">{display.apiText}</span>
        </div>
      )}

      {snapshot !== null && (
        <span className="hidden shrink-0 tabular-nums min-[1080px]:inline">
          {formatFetchedAt(snapshot.fetchedAt)} 更新
        </span>
      )}

      <button
        type="button"
        onClick={() => void refresh(true)}
        disabled={loading}
        className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md transition-colors hover:bg-[var(--lm-bg-hover)] hover:text-[var(--lm-text-secondary)] disabled:opacity-50"
        title="刷新账户用量"
        aria-label="刷新 OpenCode 订阅额度"
      >
        <RefreshCw size={12} className={loading ? 'lm-spin' : undefined} />
      </button>
    </footer>
  )
}
