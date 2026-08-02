import { useCallback, useEffect, useRef, useState } from 'react'
import { RefreshCw } from 'lucide-react'
import { useSessionStore } from '@/stores/session-store'
import { buildProviderUsageDisplay } from '@/lib/provider-usage'
import type { ProviderUsageSnapshot } from '../../shared/provider-usage-types'

const REFRESH_INTERVAL_MS = 60_000

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
  const title = ipcError === null
    ? display?.title ?? '正在查询账户用量'
    : `刷新失败：${ipcError}${display === null ? '' : `\n${display.title}`}`

  return (
    <div
      className="flex min-h-7 items-center gap-2 border-t border-[var(--lm-border)] px-3 py-1 text-[10px] text-[var(--lm-text-muted)]"
      title={title}
    >
      <div
        className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-0.5"
        role="status"
        aria-live="polite"
      >
        {display === null ? (
          <span className={ipcError === null ? undefined : 'text-[var(--lm-error)]'}>
            {ipcError === null ? '正在查询 API 余额与订阅额度…' : '用量查询失败'}
          </span>
        ) : (
          <>
            <span className={display.apiHasIssues ? 'text-[var(--lm-warning)]' : undefined}>
              {display.apiText}
            </span>
            <span aria-hidden="true">·</span>
            <span
              className={display.subscriptionHasIssues ? 'text-[var(--lm-warning)]' : undefined}
            >
              {display.subscriptionText}
            </span>
            {ipcError !== null && <span className="text-[var(--lm-error)]">刷新失败</span>}
          </>
        )}
      </div>
      <button
        type="button"
        onClick={() => void refresh(true)}
        disabled={loading}
        className="rounded p-0.5 transition-colors hover:bg-[var(--lm-bg-hover)] hover:text-[var(--lm-text-secondary)] disabled:opacity-50"
        title="刷新账户用量"
        aria-label="刷新 API 余额与订阅额度"
      >
        <RefreshCw size={11} className={loading ? 'animate-spin' : undefined} />
      </button>
    </div>
  )
}
