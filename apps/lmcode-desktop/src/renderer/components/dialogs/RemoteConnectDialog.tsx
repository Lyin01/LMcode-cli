import { useCallback, useEffect, useState } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import QRCode from 'qrcode'
import { QrCode, X } from 'lucide-react'
import type { RemoteFirewallStatus, RemoteState } from '../../../shared/remote-types'
import { buildPairingUrl, pairingQrUrl } from '../../../shared/remote-pairing'
import { CopyButton } from '@/components/CopyButton'

const QR_SIZE = 232

interface RemoteConnectDialogProps {
  readonly open: boolean
  readonly onClose: () => void
}

/**
 * One-click remote pairing: opened from the top bar or the app menu, it reads
 * the remote service state and shows the pairing QR immediately. When the
 * service is off it offers a single "开启并显示二维码" action instead of
 * silently opening a LAN port.
 */
export function RemoteConnectDialog({ open, onClose }: RemoteConnectDialogProps) {
  const [state, setState] = useState<RemoteState | null>(null)
  const [qrUrl, setQrUrl] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [firewall, setFirewall] = useState<RemoteFirewallStatus | null>(null)
  const [repairing, setRepairing] = useState(false)
  const [repaired, setRepaired] = useState(false)

  useEffect(() => {
    if (!open) return
    let disposed = false
    setError(null)
    setRepaired(false)
    void window.lmcodeAPI.getRemoteState().then((next) => {
      if (!disposed) setState(next)
    })
    void window.lmcodeAPI
      .getRemoteFirewallStatus()
      .then((status) => {
        if (!disposed) setFirewall(status)
      })
      .catch(() => {
        if (!disposed) setFirewall(null)
      })
    const unsubscribe = window.lmcodeAPI.onRemoteStateChanged((next) => {
      if (!disposed) setState(next)
    })
    return () => {
      disposed = true
      unsubscribe()
    }
  }, [open])

  useEffect(() => {
    const target = state === null ? null : pairingQrUrl(state)
    if (target === null) {
      setQrUrl(null)
      return
    }
    let disposed = false
    void QRCode.toDataURL(target, {
      width: QR_SIZE,
      margin: 1,
      color: { dark: '#1f2937', light: '#ffffff' },
    })
      .then((url) => {
        if (!disposed) setQrUrl(url)
      })
      .catch(() => {
        if (!disposed) setQrUrl(null)
      })
    return () => {
      disposed = true
    }
  }, [state])

  const enable = useCallback(async (): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      setState(await window.lmcodeAPI.setRemoteEnabled(true))
    } catch (enableError) {
      setError(enableError instanceof Error ? enableError.message : '开启远程连接失败')
    } finally {
      setBusy(false)
    }
  }, [])

  const repairFirewall = useCallback(async (): Promise<void> => {
    setRepairing(true)
    try {
      const status = await window.lmcodeAPI.repairRemoteFirewall()
      setFirewall(status)
      setRepaired(status.allowed)
    } catch (repairError) {
      setFirewall((current) => ({
        supported: current?.supported ?? true,
        allowed: false,
        error: repairError instanceof Error ? repairError.message : '修复防火墙失败',
      }))
    } finally {
      setRepairing(false)
    }
  }, [])

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose()
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay data-[state=open]:animate-in data-[state=closed]:animate-out" />
        <Dialog.Content className="dialog-content data-[state=open]:animate-in data-[state=closed]:animate-out">
          <div className="p-5">
            <div className="mb-4 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <QrCode size={16} className="text-[var(--lm-accent-text)]" />
                <Dialog.Title className="text-[15px] font-semibold text-[var(--lm-text-primary)]">
                  远程连接
                </Dialog.Title>
              </div>
              <Dialog.Close
                aria-label="关闭远程连接"
                className="rounded-md p-1 text-[var(--lm-text-muted)] transition-colors hover:bg-[var(--lm-bg-hover)] hover:text-[var(--lm-text-primary)]"
              >
                <X size={15} />
              </Dialog.Close>
            </div>
            <RemoteConnectBody
              state={state}
              qrUrl={qrUrl}
              busy={busy}
              error={error}
              firewall={firewall}
              repairing={repairing}
              repaired={repaired}
              onEnable={() => void enable()}
              onRepairFirewall={() => void repairFirewall()}
            />
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

export interface RemoteConnectBodyProps {
  readonly state: RemoteState | null
  readonly qrUrl: string | null
  readonly busy: boolean
  readonly error: string | null
  readonly firewall: RemoteFirewallStatus | null
  readonly repairing: boolean
  readonly repaired: boolean
  readonly onEnable: () => void
  readonly onRepairFirewall: () => void
}

export function RemoteConnectBody({
  state,
  qrUrl,
  busy,
  error,
  firewall,
  repairing,
  repaired,
  onEnable,
  onRepairFirewall,
}: RemoteConnectBodyProps) {
  if (state === null) {
    return <p className="text-[13px] text-[var(--lm-text-secondary)]">正在读取远程连接状态…</p>
  }

  if (!state.enabled) {
    return (
      <div className="flex flex-col items-start gap-3">
        <p className="text-[13px] leading-relaxed text-[var(--lm-text-secondary)]">
          开启后，手机扫描二维码就能打开这台电脑上的 LMCODE 远程页面，
          在手机上继续对话、审批与查看任务。服务仅在局域网 / 穿透地址上监听，随时可以关闭。
        </p>
        <button
          type="button"
          onClick={onEnable}
          disabled={busy}
          className="lm-settings-primary-action"
        >
          {busy ? '正在开启…' : '开启并显示二维码'}
        </button>
        {error !== null && (
          <p className="text-[12px] text-[var(--lm-error)]" role="alert">
            {error}
          </p>
        )}
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="lm-remote-qr">
        {qrUrl !== null ? (
          <img src={qrUrl} alt="远程连接二维码" width={QR_SIZE} height={QR_SIZE} />
        ) : state.lanUrls.length === 0 ? (
          <p className="text-[12px] text-[var(--lm-warning)]">未检测到局域网地址，请检查网络连接。</p>
        ) : (
          <p className="text-[12px] text-[var(--lm-text-muted)]">正在生成二维码…</p>
        )}
        <p>用手机相机扫码，打开页面后自动配对（无需安装 App）</p>
      </div>

      {firewall !== null && firewall.supported && !firewall.allowed && (
        <div className="rounded-lg border border-[var(--lm-border-strong)] bg-[var(--lm-bg-hover)] p-2.5">
          <p className="text-[12px] leading-relaxed text-[var(--lm-text-secondary)]">
            手机打不开页面？Windows 防火墙可能拦住了手机对这台电脑的访问。
          </p>
          <button
            type="button"
            onClick={onRepairFirewall}
            disabled={repairing}
            className="lm-settings-primary-action mt-2"
          >
            {repairing ? '正在等待管理员授权…' : '一键放行（需要管理员）'}
          </button>
          {firewall.error !== undefined && (
            <p className="mt-1 text-[12px] text-[var(--lm-error)]" role="alert">
              {firewall.error}
            </p>
          )}
        </div>
      )}
      {repaired && firewall?.allowed === true && (
        <p className="text-[12px] text-[var(--lm-accent-text)]">
          防火墙已放行，请在手机上重新扫码。
        </p>
      )}

      {state.lanUrls.length > 0 && (
        <div className="lm-remote-urls">
          {state.lanUrls.map((url) => (
            <div key={url} className="lm-remote-url-row">
              <code className="lm-settings-path">{url}</code>
              <CopyButton text={buildPairingUrl(url, state.token)} label={`复制 ${url}`} />
            </div>
          ))}
        </div>
      )}

      <div className="lm-remote-url-row">
        <span className="text-[12px] text-[var(--lm-text-muted)]">配对令牌</span>
        <code className="lm-settings-path">{state.token}</code>
        <CopyButton text={state.token} label="复制配对令牌" />
      </div>

      <p className="text-[11px] text-[var(--lm-text-muted)]">
        已连接 {state.clientCount} 台设备 · 关闭远程服务请在「设置 → 局域网远程」中操作
      </p>
      {error !== null && (
        <p className="text-[12px] text-[var(--lm-error)]" role="alert">
          {error}
        </p>
      )}
    </div>
  )
}
