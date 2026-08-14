import { useEffect, useRef, useState } from 'react'
import QRCode from 'qrcode'
import {
  Check,
  Copy,
  KeyRound,
  RefreshCw,
  ShieldAlert,
  Users,
} from 'lucide-react'
import type { RemoteState } from '../../../shared/remote-types'

const inputClass =
  'w-full rounded-lg border border-[var(--lm-border-strong)] bg-[var(--lm-bg-surface)] px-3 py-2 text-[13px] text-[var(--lm-text-primary)] outline-none transition-colors focus:border-[var(--lm-accent)] disabled:cursor-not-allowed disabled:opacity-50'

type TimerId = number

function Toggle({
  checked,
  onChange,
  disabled,
  label,
}: {
  checked: boolean
  onChange: (checked: boolean) => void
  disabled: boolean
  label: string
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={
        'relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors ' +
        (checked ? 'bg-[var(--lm-accent)]' : 'bg-[var(--lm-border-strong)]') +
        (disabled ? ' cursor-not-allowed opacity-50' : '')
      }
    >
      <span
        className={
          'inline-block h-4 w-4 transform rounded-full bg-white transition-transform ' +
          (checked ? 'translate-x-6' : 'translate-x-1')
        }
      />
    </button>
  )
}

function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false)
  const timer = useRef<TimerId | null>(null)
  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      if (timer.current !== null) clearTimeout(timer.current)
      timer.current = window.setTimeout(() => setCopied(false), 1600)
    } catch {
      // Clipboard may be unavailable in some sandboxed contexts.
    }
  }
  return (
    <button type="button" className="lm-settings-action" onClick={() => void copy()} aria-label={label}>
      {copied ? <Check size={14} /> : <Copy size={14} />}
      {copied ? '已复制' : '复制'}
    </button>
  )
}

export function RemotePanel() {
  const [state, setState] = useState<RemoteState | null>(null)
  const [portDraft, setPortDraft] = useState('')
  const [appUrlDraft, setAppUrlDraft] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [qrUrl, setQrUrl] = useState<string | null>(null)
  const portInputRef = useRef<HTMLInputElement>(null)
  const appUrlInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    let disposed = false
    void window.lmcodeAPI.getRemoteState().then((remoteState) => {
      if (disposed) return
      setState(remoteState)
      setPortDraft(String(remoteState.port))
      setAppUrlDraft(remoteState.appUrl)
    })
    const unsubscribe = window.lmcodeAPI.onRemoteStateChanged((remoteState) => {
      setState(remoteState)
      // Do not clobber in-progress edits: only sync drafts when the value
      // actually changed and the user is not focused on the input.
      const portFocused = document.activeElement === portInputRef.current
      if (!portFocused && remoteState.port !== state?.port) {
        setPortDraft(String(remoteState.port))
      }
      const appUrlFocused = document.activeElement === appUrlInputRef.current
      if (!appUrlFocused && remoteState.appUrl !== state?.appUrl) {
        setAppUrlDraft(remoteState.appUrl)
      }
    })
    return () => {
      disposed = true
      unsubscribe()
    }
  }, [state?.port, state?.appUrl])

  useEffect(() => {
    if (!state?.enabled) {
      setQrUrl(null)
      return
    }
    // QR encodes the app URL (when configured) with the token and port in the
    // hash, so scanning it opens the app with address and token pre-filled:
    //   https?://<app-host>#token=…&port=…
    if (state.appUrl.length === 0) {
      setQrUrl(null)
      return
    }
    let disposed = false
    void QRCode.toDataURL(`${state.appUrl}#token=${state.token}&port=${state.port}`, {
      width: 200,
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
  }, [state?.enabled, state?.appUrl, state?.token, state?.port])

  const runMutation = async (action: () => Promise<RemoteState>): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      const next = await action()
      setState(next)
      setPortDraft(String(next.port))
    } catch (err) {
      setError(err instanceof Error ? err.message : '操作失败')
    } finally {
      setBusy(false)
    }
  }

  const savePort = async (): Promise<void> => {
    const parsed = Number.parseInt(portDraft, 10)
    if (!Number.isFinite(parsed)) {
      setError('端口必须是数字')
      return
    }
    await runMutation(() => window.lmcodeAPI.setRemotePort(parsed))
  }

  const saveAppUrl = async (): Promise<void> => {
    await runMutation(() => window.lmcodeAPI.setRemoteAppUrl(appUrlDraft.trim()))
  }

  const toggleEnabled = (enabled: boolean): void => {
    void runMutation(() => window.lmcodeAPI.setRemoteEnabled(enabled))
  }

  if (state === null) {
    return (
      <div className="lm-settings-card">
        <div className="lm-settings-value">正在读取远程连接状态…</div>
      </div>
    )
  }

  return (
    <div className="lm-settings-provider-surface lm-remote-surface">
      <section className="lm-settings-section">
        <h2>远程服务</h2>
        <div className="lm-settings-card">
          <div className="lm-settings-row">
            <div className="lm-settings-row-copy">
              <span className="lm-settings-row-title">允许远程连接</span>
              <p>
                开启后，lmcode app（手机 / 其他电脑 / 浏览器）可以通过令牌远程连接
                这台电脑上的 LMCODE Desktop，进行对话、审批与任务控制。
              </p>
            </div>
            <div className="lm-settings-row-control">
              <Toggle
                checked={state.enabled}
                onChange={toggleEnabled}
                disabled={busy}
                label="允许远程连接"
              />
            </div>
          </div>
          {state.enabled && (
            <div className="lm-settings-row">
              <div className="lm-settings-row-copy">
                <span className="lm-settings-row-title">已连接客户端</span>
                <p>当前接入的远程设备数量。</p>
              </div>
              <div className="lm-settings-row-control lm-settings-value">
                <Users size={14} />
                {state.clientCount}
              </div>
            </div>
          )}
        </div>
      </section>

      {state.enabled && (
        <>
          <section className="lm-settings-section">
            <h2>连接方式</h2>
            <div className="lm-settings-card">
              <div className="lm-settings-row">
                <div className="lm-settings-row-copy">
                  <span className="lm-settings-row-title">App 页面地址</span>
                  <p>
                    手机要访问的 lmcode app 页面（部署构建产物后的地址，如{' '}
                    <code>http://192.168.1.100:4173</code>）。填入后，二维码会直达
                    app 并自动带上令牌和端口。
                  </p>
                </div>
                <div className="lm-settings-row-control lm-remote-port-control">
                  <input
                    ref={appUrlInputRef}
                    className={inputClass}
                    type="text"
                    placeholder="http://192.168.1.100:4173"
                    value={appUrlDraft}
                    disabled={busy}
                    onChange={(event) => setAppUrlDraft(event.target.value)}
                  />
                  <button
                    type="button"
                    className="lm-settings-action"
                    disabled={busy || appUrlDraft.trim() === state.appUrl}
                    onClick={() => void saveAppUrl()}
                  >
                    保存
                  </button>
                </div>
              </div>
              <div className="lm-settings-row lm-settings-row-top">
                <div className="lm-settings-row-copy">
                  <span className="lm-settings-row-title">局域网地址</span>
                  <p>同一 WiFi / 局域网内的设备使用以下 ws 地址连接。</p>
                  {state.lanUrls.length > 0 && (
                    <div className="lm-remote-urls">
                      {state.lanUrls.map((url) => (
                        <div key={url} className="lm-remote-url-row">
                          <code className="lm-settings-path">{url.replace(/^http/, 'ws')}/ws</code>
                          <CopyButton text={`${url.replace(/^http/, 'ws')}/ws`} label={`复制 ${url}`} />
                        </div>
                      ))}
                    </div>
                  )}
                  {state.lanUrls.length === 0 && (
                    <p className="lm-remote-empty">未检测到局域网地址，请检查网络连接。</p>
                  )}
                </div>
              </div>
              {qrUrl && (
                <div className="lm-remote-qr">
                  <img src={qrUrl} alt="远程连接二维码" width={200} height={200} />
                  <p>用手机扫一扫：打开 app 并自动填好地址和令牌</p>
                </div>
              )}
              {!qrUrl && state.appUrl.length === 0 && (
                <p className="lm-remote-empty">
                  填写上方 App 页面地址后即可生成二维码，手机扫码一步连接。
                </p>
              )}
            </div>
          </section>

          <section className="lm-settings-section">
            <h2>令牌</h2>
            <div className="lm-settings-card">
              <div className="lm-settings-row lm-settings-row-top">
                <div className="lm-settings-row-copy">
                  <span className="lm-settings-row-title">配对令牌</span>
                  <p>令牌即密码：远程客户端用它鉴权。重新生成后，旧令牌立即失效。</p>
                </div>
                <div className="lm-settings-row-control lm-remote-token-control">
                  <div className="lm-remote-token-box">
                    <KeyRound size={14} />
                    <code>{state.token}</code>
                  </div>
                  <div className="lm-remote-token-actions">
                    <CopyButton text={state.token} label="复制令牌" />
                    <button
                      type="button"
                      className="lm-settings-action"
                      disabled={busy}
                      onClick={() => void runMutation(() => window.lmcodeAPI.regenerateRemoteToken())}
                    >
                      <RefreshCw size={14} />
                      重新生成
                    </button>
                  </div>
                </div>
              </div>
            </div>
          </section>

          <section className="lm-settings-section">
            <h2>端口</h2>
            <div className="lm-settings-card">
              <div className="lm-settings-row">
                <div className="lm-settings-row-copy">
                  <span className="lm-settings-row-title">监听端口</span>
                  <p>远程服务的 HTTP/WebSocket 端口，修改后立即生效。</p>
                </div>
                <div className="lm-settings-row-control lm-remote-port-control">
                  <input
                    ref={portInputRef}
                    className={inputClass}
                    type="number"
                    min={1024}
                    max={65535}
                    value={portDraft}
                    disabled={busy}
                    onChange={(event) => setPortDraft(event.target.value)}
                  />
                  <button
                    type="button"
                    className="lm-settings-action"
                    disabled={busy || portDraft === String(state.port)}
                    onClick={() => void savePort()}
                  >
                    保存
                  </button>
                </div>
              </div>
            </div>
          </section>

          <section className="lm-settings-section">
            <h2>从外网连接（可选）</h2>
            <div className="lm-settings-card">
              <div className="lm-settings-row">
                <div className="lm-settings-row-copy">
                  <span className="lm-settings-row-title">公网穿透</span>
                  <p>
                    想在外面也能连上，请用穿透工具把端口 {state.port} 映射到公网，然后在
                    lmcode app 里填写对应的 ws/wss 地址：
                  </p>
                  <ul className="lm-remote-tunnel-list">
                    <li>
                      <code>Tailscale</code>
                      <span>：两台设备登录同一账号，直接用 Tailscale 分配的地址。</span>
                    </li>
                    <li>
                      <code>ngrok</code>
                      <span>：ngrok http {state.port}，用返回的 https 地址（wss 自动生效）。</span>
                    </li>
                    <li>
                      <code>frp</code>
                      <span>：映射 tcp 端口，客户端填 ws://frp地址:端口。</span>
                    </li>
                  </ul>
                </div>
              </div>
            </div>
          </section>

          <div className="lm-settings-callout">
            <ShieldAlert size={17} />
            <div>
              <strong>安全提醒</strong>
              <p>
                远程连接会暴露会话、审批和任务控制能力。请勿把令牌发给他人，尽量使用
                wss / 可信网络，并在用完后关闭远程服务。
              </p>
            </div>
          </div>
        </>
      )}

      {error && <div className="lm-settings-callout lm-remote-error">{error}</div>}
    </div>
  )
}
