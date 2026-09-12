import { useState } from 'react'

export interface PairingViewProps {
  readonly error: string | null
  readonly busy: boolean
  readonly canForget: boolean
  readonly onSubmit: (token: string) => void
  readonly onForget: () => void
}

export function PairingView({ error, busy, canForget, onSubmit, onForget }: PairingViewProps) {
  const [draft, setDraft] = useState('')
  const canSubmit = draft.trim().length > 0 && !busy

  return (
    <div className="rm-pairing">
      <div className="rm-logo">LMCODE</div>
      <h1>连接电脑</h1>
      <p className="rm-muted">
        在电脑上打开 LMCODE Desktop → 设置 → 远程连接，用手机相机扫描二维码即可自动配对；
        也可以把下方显示的配对令牌粘贴到这里。
      </p>
      <form
        className="rm-pairing-form"
        onSubmit={(event) => {
          event.preventDefault()
          if (canSubmit) onSubmit(draft.trim())
        }}
      >
        <input
          className="rm-input"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder="粘贴配对令牌"
          autoCapitalize="off"
          autoCorrect="off"
          autoComplete="off"
          spellCheck={false}
          enterKeyHint="go"
          disabled={busy}
        />
        <button className="rm-primary" type="submit" disabled={!canSubmit}>
          连接
        </button>
      </form>
      {error !== null && <div className="rm-error">{error}</div>}
      {canForget && (
        <button className="rm-link" type="button" onClick={onForget}>
          清除本机已保存的配对
        </button>
      )}
    </div>
  )
}
