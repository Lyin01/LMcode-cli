import { useCallback, useEffect, useState } from 'react'
import { Check, Download, ExternalLink, RefreshCw, ShieldAlert } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useConfigStore } from '@/stores/config-store'
import { useSessionStore } from '@/stores/session-store'
import {
  applyComputerUseEnabled,
  requestComputerUseInstall,
  runComputerUseInstall,
  type PendingComputerUseInstall,
} from '@/lib/computer-use'
import { isSafeExternalHref } from '@/lib/open-target'
import type { ComputerUsePermissionMode, ComputerUseStatus } from '@lmcode-cli/lmcode-sdk'
import type {
  ComputerUseDriverInfo,
  ComputerUseInstallResult,
} from '../../../shared/computer-use-types'

/** Provider docs page; mirrors `docsUrl` in the SDK provider descriptor. */
const COMPUTER_USE_DOCS_URL = 'https://cua.ai/docs/how-to-guides/driver/connect-your-agent'

/**
 * Launch-time permission modes. The SDK exports COMPUTER_USE_PERMISSION_MODES,
 * but the SDK is a Node-only bundle that the renderer must not import at
 * runtime (it pulls `node:*` into the browser bundle), so the list lives here
 * behind the SDK type — drift becomes a typecheck error.
 */
const PERMISSION_MODE_OPTIONS: readonly {
  value: ComputerUsePermissionMode
  label: string
  hint: string
}[] = [
  { value: 'standard', label: '标准', hint: '默认模式：可向桌面上的任意应用发送操作。' },
  { value: 'bounded', label: '受限', hint: '只允许能力清单中已审查的应用、来源与目录。' },
  { value: 'unrestricted', label: '不受限', hint: '驱动侧不再附加限制，范围最大，仅建议在受控环境使用。' },
]

const PHASE_LABEL: Record<ComputerUseStatus['phase'], string> = {
  idle: '未启动',
  starting: '启动中',
  active: '运行中',
  failed: '失败',
}

const PHASE_DOT: Record<ComputerUseStatus['phase'], string> = {
  idle: 'bg-[var(--lm-text-muted)]',
  starting: 'bg-[var(--lm-warning)]',
  active: 'bg-[var(--lm-success)]',
  failed: 'bg-[var(--lm-error)]',
}

/**
 * Config-driven computer use starts alongside the session, so the first status
 * read can legitimately land on `starting`. Poll a bounded number of times so
 * the card settles instead of staying on "启动中" until the user acts.
 */
const STATUS_SETTLE_POLLS = 20
const STATUS_SETTLE_INTERVAL_MS = 500

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function ComputerUsePanel() {
  const config = useConfigStore((s) => s.config)
  const updateConfig = useConfigStore((s) => s.updateConfig)
  const currentSessionId = useSessionStore((s) => s.currentSessionId)

  const enabled = config?.computerUse?.enabled ?? false
  const permissionMode = config?.computerUse?.permissionMode

  const [driver, setDriver] = useState<ComputerUseDriverInfo | null>(null)
  const [driverBusy, setDriverBusy] = useState(false)
  const [driverError, setDriverError] = useState<string | null>(null)
  const [pendingInstall, setPendingInstall] = useState<PendingComputerUseInstall | null>(null)
  const [installing, setInstalling] = useState(false)
  const [installResult, setInstallResult] = useState<ComputerUseInstallResult | null>(null)
  const [status, setStatus] = useState<ComputerUseStatus | null>(null)
  const [statusError, setStatusError] = useState<string | null>(null)
  const [toggling, setToggling] = useState(false)
  const [toggleNotice, setToggleNotice] = useState<string | null>(null)
  const [toggleError, setToggleError] = useState<string | null>(null)
  const [modeError, setModeError] = useState<string | null>(null)

  const refreshDriver = useCallback(async (): Promise<void> => {
    setDriverBusy(true)
    setDriverError(null)
    try {
      setDriver(await window.lmcodeAPI.getComputerUseDriver())
    } catch (error) {
      setDriver(null)
      setDriverError(errorText(error))
    } finally {
      setDriverBusy(false)
    }
  }, [])

  useEffect(() => {
    void refreshDriver()
  }, [refreshDriver])

  useEffect(() => {
    let disposed = false
    let timer: ReturnType<typeof setTimeout> | undefined
    setStatus(null)
    setStatusError(null)
    if (currentSessionId === null) return

    const read = async (attempt: number): Promise<void> => {
      try {
        const next = await window.lmcodeAPI.getComputerUseStatus(currentSessionId)
        if (disposed) return
        setStatus(next)
        if (next.phase === 'starting' && attempt < STATUS_SETTLE_POLLS) {
          timer = setTimeout(() => void read(attempt + 1), STATUS_SETTLE_INTERVAL_MS)
        }
      } catch (error: unknown) {
        if (!disposed) setStatusError(errorText(error))
      }
    }
    void read(0)

    return () => {
      disposed = true
      if (timer !== undefined) clearTimeout(timer)
    }
  }, [currentSessionId])

  const handleToggle = (): void => {
    if (toggling) return
    const next = !enabled
    setToggling(true)
    setToggleNotice(null)
    setToggleError(null)
    void (async () => {
      try {
        const outcome = await applyComputerUseEnabled(currentSessionId, next)
        if (outcome.status !== null) setStatus(outcome.status)
        if (!outcome.sessionApplied) {
          setToggleNotice('偏好已保存；当前没有打开的任务，打开任务后自动生效。')
        }
      } catch (error) {
        setToggleError(`切换失败：${errorText(error)}`)
      } finally {
        setToggling(false)
      }
    })()
  }

  const handleModeChange = (mode: ComputerUsePermissionMode): void => {
    if (mode === permissionMode) return
    setModeError(null)
    void (async () => {
      try {
        await updateConfig({ computerUse: { ...config?.computerUse, permissionMode: mode } })
      } catch (error) {
        setModeError(`模式保存失败：${errorText(error)}`)
      }
    })()
  }

  const armInstall = (): void => {
    const decision = requestComputerUseInstall(null, Date.now())
    setInstallResult(null)
    setPendingInstall(decision.pending)
  }

  const confirmInstall = (): void => {
    if (installing) return
    setInstalling(true)
    void (async () => {
      try {
        const attempt = await runComputerUseInstall(pendingInstall, Date.now())
        setPendingInstall(attempt.pending)
        if (attempt.result === null) return
        setInstallResult(attempt.result)
        if (attempt.result.ok) await refreshDriver()
      } catch (error) {
        setPendingInstall(null)
        setInstallResult({ ok: false, output: errorText(error) })
      } finally {
        setInstalling(false)
      }
    })()
  }

  const openDocs = (): void => {
    if (!isSafeExternalHref(COMPUTER_USE_DOCS_URL)) return
    void window.lmcodeAPI.openExternal(COMPUTER_USE_DOCS_URL).catch((error: unknown) => {
      console.error('openExternal failed:', error)
    })
  }

  const driverMissing = driver !== null && !driver.found

  return (
    <section className="space-y-2 pt-2 border-t border-[var(--lm-border)]" id="settings-computer-use">
      <div className="flex items-start justify-between gap-3">
        <div className="space-y-1">
          <label className="text-[13px] font-semibold text-[var(--lm-text-primary)]">电脑操作 (Computer Use)</label>
          <p className="text-[11.5px] text-[var(--lm-text-muted)]">
            让 Agent 通过 Cua Driver 直接操作这台电脑的真实桌面：点击、输入、读取窗口。
            每一项桌面操作仍会走常规工具审批，不会绕过确认。
          </p>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={enabled}
          aria-label="电脑操作总开关"
          onClick={handleToggle}
          disabled={toggling}
          className={cn(
            'flex shrink-0 items-center gap-2 rounded-xl border px-3 py-2 text-[12px] font-medium transition-all',
            enabled
              ? 'border-[var(--lm-accent)] bg-[var(--lm-accent-soft)] text-[var(--lm-accent-text)]'
              : 'border-[var(--lm-border)] bg-[var(--lm-bg-base)] text-[var(--lm-text-secondary)] hover:bg-[var(--lm-bg-hover)]',
            toggling && 'opacity-60',
          )}
        >
          <span
            className={cn('h-2 w-2 rounded-full', enabled ? 'bg-[var(--lm-accent)]' : 'bg-[var(--lm-text-muted)]')}
          />
          {toggling ? '切换中…' : enabled ? '已开启' : '已关闭'}
        </button>
      </div>

      {toggleNotice !== null && <p className="text-[11px] text-[var(--lm-accent-text)]">{toggleNotice}</p>}
      {toggleError !== null && <p className="text-[11px] text-[var(--lm-error)]">{toggleError}</p>}

      {/* Driver detection */}
      <div className="rounded-xl border border-[var(--lm-border)] bg-[var(--lm-bg-base)] p-3">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 space-y-1">
            <div className="flex items-center gap-2 text-[12.5px] font-medium text-[var(--lm-text-primary)]">
              <span
                className={cn(
                  'h-2 w-2 shrink-0 rounded-full',
                  driver?.found ? 'bg-[var(--lm-success)]' : 'bg-[var(--lm-text-muted)]',
                )}
              />
              <span>{driverBusy ? '正在检测驱动…' : driver?.found ? '已检测到驱动' : '未检测到驱动'}</span>
            </div>
            {driver?.found && driver.version !== undefined && (
              <p className="text-[11px] text-[var(--lm-text-muted)]">{driver.version}</p>
            )}
            {driver?.found && driver.path !== undefined && (
              <p className="break-all font-mono text-[10.5px] text-[var(--lm-text-muted)]">{driver.path}</p>
            )}
            {!driverBusy && !driver?.found && (
              <p className="text-[11px] text-[var(--lm-text-muted)]">
                电脑操作需要厂商的 Cua Driver。未检测到时可一键安装，或自行安装后重新检测。
              </p>
            )}
            {driverError !== null && <p className="text-[11px] text-[var(--lm-error)]">驱动检测失败：{driverError}</p>}
          </div>
          <button
            type="button"
            onClick={() => void refreshDriver()}
            disabled={driverBusy}
            className="flex shrink-0 items-center gap-1.5 rounded-lg border border-[var(--lm-border)] bg-[var(--lm-bg-surface)] px-2.5 py-1.5 text-[12px] font-medium text-[var(--lm-text-secondary)] transition-colors hover:bg-[var(--lm-bg-hover)] hover:text-[var(--lm-text-primary)] disabled:cursor-not-allowed disabled:opacity-50"
          >
            <RefreshCw size={13} className={cn(driverBusy && 'animate-spin')} />
            <span>检测驱动</span>
          </button>
        </div>
      </div>

      {/* Install one-click (only worth offering when no driver was detected) */}
      {(driverMissing || driverError !== null) && (
        <div className="space-y-2 rounded-xl border border-[var(--lm-border)] bg-[var(--lm-bg-base)] p-3">
          {pendingInstall === null ? (
            <>
              <p className="text-[11.5px] text-[var(--lm-text-muted)]">
                一键安装会从厂商官网下载并执行 Cua Driver 官方安装脚本（cua.ai/driver/install），
                需要联网并以当前用户身份运行。
              </p>
              <button
                type="button"
                onClick={armInstall}
                disabled={installing}
                className="flex items-center gap-1.5 rounded-lg border border-[var(--lm-accent)] bg-[var(--lm-accent-soft)] px-3 py-1.5 text-[12px] font-medium text-[var(--lm-accent-text)] transition-colors hover:bg-[var(--lm-bg-hover)] disabled:cursor-not-allowed disabled:opacity-50"
              >
                <Download size={13} />
                <span>一键安装</span>
              </button>
            </>
          ) : (
            <>
              <p className="text-[12px] font-medium text-[var(--lm-text-primary)]">确认安装并执行官方脚本？</p>
              <p className="text-[11.5px] text-[var(--lm-text-muted)]">
                将从 cua.ai 下载安装脚本并在本机执行；脚本来自驱动厂商，安装过程不经过 LMcode 审批。
              </p>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={confirmInstall}
                  disabled={installing}
                  className="flex items-center gap-1.5 rounded-lg border border-[var(--lm-accent)] bg-[var(--lm-accent-soft)] px-3 py-1.5 text-[12px] font-medium text-[var(--lm-accent-text)] transition-colors hover:bg-[var(--lm-bg-hover)] disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <Download size={13} />
                  <span>{installing ? '正在安装…' : '确认并执行'}</span>
                </button>
                <button
                  type="button"
                  onClick={() => setPendingInstall(null)}
                  disabled={installing}
                  className="rounded-lg border border-[var(--lm-border)] bg-[var(--lm-bg-surface)] px-3 py-1.5 text-[12px] font-medium text-[var(--lm-text-secondary)] transition-colors hover:bg-[var(--lm-bg-hover)] hover:text-[var(--lm-text-primary)] disabled:cursor-not-allowed disabled:opacity-50"
                >
                  取消
                </button>
              </div>
            </>
          )}
          {installResult?.ok === true && (
            <p className="text-[11px] text-[var(--lm-success)]">安装完成，已重新检测驱动。</p>
          )}
          {installResult?.ok === false && (
            <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-all rounded-lg border border-[var(--lm-border)] bg-[var(--lm-bg-code)] p-2 font-mono text-[10.5px] text-[var(--lm-error)]">
              {installResult.output.length > 0 ? installResult.output : '安装失败，未返回输出。'}
            </pre>
          )}
        </div>
      )}

      {/* Live capability status */}
      <div className="rounded-xl border border-[var(--lm-border)] bg-[var(--lm-bg-base)] p-3">
        <div className="flex items-center gap-2 text-[12.5px] font-medium text-[var(--lm-text-primary)]">
          <span
            className={cn('h-2 w-2 shrink-0 rounded-full', status !== null ? PHASE_DOT[status.phase] : 'bg-[var(--lm-text-muted)]')}
          />
          <span>
            桌面控制状态：
            {status !== null ? PHASE_LABEL[status.phase] : currentSessionId === null ? '未打开任务' : '读取中…'}
          </span>
        </div>
        <div className="mt-1 space-y-0.5">
          {status !== null && (
            <p className="text-[11px] text-[var(--lm-text-muted)]">
              提供方：{status.label}
              {status.phase === 'active' ? ` · 已挂载 ${String(status.toolCount)} 个桌面工具` : ''}
            </p>
          )}
          {status?.phase === 'failed' && status.error !== undefined && (
            <p className="text-[11px] text-[var(--lm-error)]">失败原因：{status.error}</p>
          )}
          {statusError !== null && <p className="text-[11px] text-[var(--lm-error)]">状态读取失败：{statusError}</p>}
          {currentSessionId === null && (
            <p className="text-[11px] text-[var(--lm-text-muted)]">
              当前没有打开的任务；开关只保存偏好，打开任务后自动应用。
            </p>
          )}
        </div>
      </div>

      {enabled && (
        <div className="space-y-1.5">
          <div className="text-[12px] font-medium text-[var(--lm-text-secondary)]">驱动权限模式</div>
          <p className="text-[11px] text-[var(--lm-text-muted)]">驱动在启动时固定权限模式，修改后在下次启动时生效。</p>
          {PERMISSION_MODE_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              type="button"
              onClick={() => handleModeChange(opt.value)}
              className={cn(
                'flex w-full items-center justify-between rounded-xl border px-3.5 py-2.5 text-left transition-all',
                permissionMode === opt.value
                  ? 'border-[var(--lm-accent)] bg-[var(--lm-accent-soft)] text-[var(--lm-text-primary)]'
                  : 'border-[var(--lm-border)] bg-[var(--lm-bg-base)] hover:bg-[var(--lm-bg-hover)]',
              )}
            >
              <div>
                <div className="text-[13px] font-medium text-[var(--lm-text-primary)]">{opt.label}</div>
                <div className="text-[11px] text-[var(--lm-text-muted)]">{opt.hint}</div>
              </div>
              {permissionMode === opt.value && <Check size={16} className="text-[var(--lm-accent-text)]" />}
            </button>
          ))}
          {modeError !== null && <p className="text-[11px] text-[var(--lm-error)]">{modeError}</p>}
        </div>
      )}

      <div className="flex items-center justify-between gap-3 pt-1">
        <p className="flex items-center gap-1.5 text-[11px] text-[var(--lm-text-muted)]">
          <ShieldAlert size={13} className="shrink-0 text-[var(--lm-warning)]" />
          桌面控制权限很大，请只在信任的任务里开启。
        </p>
        <button
          type="button"
          onClick={openDocs}
          className="flex shrink-0 items-center gap-1 text-[11.5px] text-[var(--lm-accent-text)] hover:underline"
        >
          <span>官方文档</span>
          <ExternalLink size={11} />
        </button>
      </div>
    </section>
  )
}
