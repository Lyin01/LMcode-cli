import { useEffect, useMemo, useRef, useState } from 'react'
import { Plus, Trash2, Eye, EyeOff, ChevronRight, Check, Pencil, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useConfigStore } from '@/stores/config-store'
import type { LmcodeConfig } from '@lmcode-cli/lmcode-sdk'
import { REDACTED_SECRET_VALUE } from '../../../shared/security'

type ProviderType = LmcodeConfig['providers'][string]['type']
type ModelAlias = NonNullable<LmcodeConfig['models']>[string]

/**
 * API 格式选项，按 ZCode「模型设置」的风格展示：
 * 每个格式附带其默认接口路径，供用户对照填写 Base URL。
 */
const PROVIDER_TYPES: { value: ProviderType; label: string; endpointPath: string }[] = [
  { value: 'anthropic', label: 'Anthropic Messages', endpointPath: '/v1/messages' },
  { value: 'openai', label: 'Chat Completions', endpointPath: '/v1/chat/completions' },
  { value: 'openai_responses', label: 'Responses', endpointPath: '/v1/responses' },
  { value: 'google-genai', label: 'Google GenAI', endpointPath: '/v1beta/models' },
  { value: 'lmcode', label: 'LMcode', endpointPath: '/v1/chat/completions' },
  { value: 'vertexai', label: 'Vertex AI', endpointPath: '/v1/projects/…' },
]

const providerTypeLabel = (type: ProviderType) =>
  PROVIDER_TYPES.find((t) => t.value === type)?.label ?? type

const providerEndpointPath = (type: ProviderType) =>
  PROVIDER_TYPES.find((t) => t.value === type)?.endpointPath ?? ''

const inputClass =
  'w-full rounded-lg border border-[var(--lm-border-strong)] bg-[var(--lm-bg-surface)] px-3 py-2 text-[13px] text-[var(--lm-text-primary)] outline-none transition-colors focus:border-[var(--lm-accent)] disabled:cursor-not-allowed disabled:opacity-50'

const labelClass = 'mb-1.5 block text-[12px] font-medium text-[var(--lm-text-secondary)]'

function formatContextSize(n: number): string {
  if (n >= 10_000) {
    const wan = n / 10_000
    return `${Number.isInteger(wan) ? wan : wan.toFixed(1)}万`
  }
  return String(n)
}

type View = { kind: 'list' } | { kind: 'edit'; id: string | null }

export function ModelProvidersPanel() {
  const config = useConfigStore((s) => s.config)
  const updateConfig = useConfigStore((s) => s.updateConfig)
  const removeProvider = useConfigStore((s) => s.removeProvider)
  const [view, setView] = useState<View>({ kind: 'list' })
  const togglingIds = useRef(new Set<string>())

  const providers = useMemo(() => {
    if (!config?.providers) return []
    return Object.entries(config.providers).sort(([a], [b]) => a.localeCompare(b))
  }, [config])

  const modelCountByProvider = useMemo(() => {
    const counts: Record<string, number> = {}
    for (const alias of Object.values(config?.models ?? {})) {
      counts[alias.provider] = (counts[alias.provider] ?? 0) + 1
    }
    return counts
  }, [config])

  const editingMissing =
    view.kind === 'edit' && view.id !== null && !config?.providers?.[view.id]
  useEffect(() => {
    // Provider was deleted while editing; fall back to the list.
    if (editingMissing) setView({ kind: 'list' })
  }, [editingMissing])

  if (view.kind === 'edit') {
    const existing = view.id !== null ? (config?.providers?.[view.id] ?? null) : null
    return (
      <ProviderEditor
        providerId={view.id}
        provider={existing}
        onBack={() => setView({ kind: 'list' })}
        onSaved={(id) => setView({ kind: 'edit', id })}
        onDeleted={async (id) => {
          await removeProvider(id)
          setView({ kind: 'list' })
        }}
      />
    )
  }

  return (
    <div className="space-y-2">
      <p className="text-[11px] text-[var(--lm-text-muted)]">
        管理自定义模型供应商，配置后可在聊天时选择使用。
      </p>
      {providers.length === 0 && (
        <div className="rounded-lg border border-dashed border-[var(--lm-border-strong)] px-3 py-6 text-center text-[12px] text-[var(--lm-text-muted)]">
          还没有配置供应商
        </div>
      )}
      {providers.map(([id, provider]) => {
        const enabled = provider.enabled !== false
        return (
          <div
            key={id}
            className="flex w-full items-center gap-2 rounded-lg border border-[var(--lm-border)] bg-[var(--lm-bg-surface)] px-3 py-2.5 transition-colors hover:bg-[var(--lm-bg-hover)]"
          >
            <button
              type="button"
              onClick={() => setView({ kind: 'edit', id })}
              className="flex min-w-0 flex-1 items-center gap-2.5 text-left"
            >
              <span
                className={cn(
                  'h-1.5 w-1.5 shrink-0 rounded-full',
                  enabled ? 'bg-green-500' : 'bg-[var(--lm-text-muted)]',
                )}
                title={enabled ? '已启用' : '已禁用'}
              />
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate text-[13px] font-medium text-[var(--lm-text-primary)]">
                  {id}
                </span>
                <span className="truncate text-[11px] text-[var(--lm-text-muted)]">
                  {providerTypeLabel(provider.type)}
                  {(modelCountByProvider[id] ?? 0) > 0 && ` · ${modelCountByProvider[id]} 个模型`}
                </span>
              </span>
              <ChevronRight size={14} className="shrink-0 text-[var(--lm-text-muted)]" />
            </button>
            <button
              type="button"
              onClick={() => {
                if (togglingIds.current.has(id)) return
                togglingIds.current.add(id)
                void updateConfig({ providers: { [id]: { enabled: !enabled } } }).finally(() => {
                  togglingIds.current.delete(id)
                })
              }}
              className={cn(
                'shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium transition-colors',
                enabled
                  ? 'bg-green-500/15 text-green-600 hover:bg-green-500/25 dark:text-green-400'
                  : 'bg-[var(--lm-bg-hover)] text-[var(--lm-text-muted)] hover:text-[var(--lm-text-secondary)]',
              )}
            >
              {enabled ? '已启用' : '禁用'}
            </button>
          </div>
        )
      })}
      <button
        onClick={() => setView({ kind: 'edit', id: null })}
        className="flex w-full items-center justify-center gap-1.5 rounded-lg border border-dashed border-[var(--lm-border-strong)] px-3 py-2 text-[12px] font-medium text-[var(--lm-text-secondary)] transition-colors hover:border-[var(--lm-accent)] hover:text-[var(--lm-text-primary)]"
      >
        <Plus size={13} />
        添加供应商
      </button>
    </div>
  )
}

interface ProviderEditorProps {
  providerId: string | null
  provider: LmcodeConfig['providers'][string] | null
  onBack: () => void
  onSaved: (id: string) => void
  onDeleted: (id: string) => Promise<void>
}

function ProviderEditor({ providerId, provider, onBack, onSaved, onDeleted }: ProviderEditorProps) {
  const updateConfig = useConfigStore((s) => s.updateConfig)
  const isNew = providerId === null

  const [id, setId] = useState(providerId ?? '')
  const [type, setType] = useState<ProviderType>(provider?.type ?? 'anthropic')
  const [baseUrl, setBaseUrl] = useState(provider?.baseUrl ?? '')
  const [apiKey, setApiKey] = useState(
    provider?.apiKey === REDACTED_SECRET_VALUE ? '' : (provider?.apiKey ?? ''),
  )
  const [preserveStoredApiKey, setPreserveStoredApiKey] = useState(
    provider?.apiKey === REDACTED_SECRET_VALUE,
  )
  const [showApiKey, setShowApiKey] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [error, setError] = useState('')
  const savedTimer = useRef<number | null>(null)
  const deleteTimer = useRef<number | null>(null)

  useEffect(() => {
    return () => {
      if (savedTimer.current !== null) window.clearTimeout(savedTimer.current)
      if (deleteTimer.current !== null) window.clearTimeout(deleteTimer.current)
    }
  }, [])

  const idConflict = useConfigStore((s) =>
    isNew ? Boolean(s.config?.providers?.[id.trim()]) : false,
  )
  const canSave = id.trim().length > 0 && !idConflict && !saving
  const savingRef = useRef(false)

  const handleSave = async () => {
    if (!canSave || savingRef.current) return
    savingRef.current = true
    setSaving(true)
    setError('')
    try {
      const trimmedId = id.trim()
      const nextApiKey = preserveStoredApiKey
        ? REDACTED_SECRET_VALUE
        : apiKey.trim()
      await updateConfig({
        providers: {
          [trimmedId]: {
            type,
            baseUrl: baseUrl.trim(),
            apiKey: nextApiKey,
            enabled: provider?.enabled ?? true,
          },
        },
      })
      setApiKey('')
      setPreserveStoredApiKey(nextApiKey.length > 0)
      setSaved(true)
      if (savedTimer.current !== null) window.clearTimeout(savedTimer.current)
      savedTimer.current = window.setTimeout(() => setSaved(false), 2000)
      onSaved(trimmedId)
    } catch (err) {
      setError(err instanceof Error ? err.message : '保存失败')
    } finally {
      savingRef.current = false
      setSaving(false)
    }
  }

  const handleDelete = async () => {
    if (!confirmDelete) {
      setConfirmDelete(true)
      if (deleteTimer.current !== null) window.clearTimeout(deleteTimer.current)
      deleteTimer.current = window.setTimeout(() => setConfirmDelete(false), 3000)
      return
    }
    if (providerId !== null) await onDeleted(providerId)
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <button
          onClick={onBack}
          className="text-[12px] text-[var(--lm-text-muted)] transition-colors hover:text-[var(--lm-text-primary)]"
        >
          ← 返回列表
        </button>
        {!isNew && (
          <button
            onClick={handleDelete}
            className={cn(
              'flex items-center gap-1 rounded-md px-2 py-1 text-[11px] transition-colors',
              confirmDelete
                ? 'bg-red-500/15 text-red-500'
                : 'text-[var(--lm-text-muted)] hover:text-red-500',
            )}
          >
            <Trash2 size={12} />
            {confirmDelete ? '确认删除？' : '删除'}
          </button>
        )}
      </div>

      <section>
        <label className={labelClass}>名称</label>
        <input
          value={id}
          disabled={!isNew}
          onChange={(e) => setId(e.target.value)}
          placeholder="例如 kimi、deepseek"
          className={inputClass}
        />
        {idConflict && (
          <p className="mt-1 text-[11px] text-red-500">该名称已存在</p>
        )}
      </section>

      <section>
        <label className={labelClass}>API 格式</label>
        <select
          value={type}
          onChange={(e) => setType(e.target.value as ProviderType)}
          className={inputClass}
        >
          {PROVIDER_TYPES.map((t) => (
            <option key={t.value} value={t.value}>
              {t.label} ({t.endpointPath})
            </option>
          ))}
        </select>
        <p className="mt-1 text-[11px] text-[var(--lm-text-muted)]">
          接口路径：{providerEndpointPath(type)}（写入 Base URL，不会自动拼接）
        </p>
      </section>

      <section>
        <label className={labelClass}>Base URL</label>
        <input
          value={baseUrl}
          onChange={(e) => setBaseUrl(e.target.value)}
          placeholder="https://api.example.com/v1"
          className={inputClass}
        />
      </section>

      <section>
        <label className={labelClass}>API Key</label>
        <div className="relative">
          <input
            value={apiKey}
            type={showApiKey ? 'text' : 'password'}
            onChange={(e) => {
              const value = e.target.value
              setApiKey(value)
              setPreserveStoredApiKey(
                provider?.apiKey === REDACTED_SECRET_VALUE && value.trim().length === 0,
              )
            }}
            placeholder={preserveStoredApiKey ? '已安全保存；输入新密钥可替换' : '输入 API Key'}
            className={cn(inputClass, 'pr-9')}
          />
          <button
            onClick={() => setShowApiKey((v) => !v)}
            className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-[var(--lm-text-muted)] transition-colors hover:text-[var(--lm-text-primary)]"
            title={showApiKey ? '隐藏' : '显示'}
          >
            {showApiKey ? <EyeOff size={14} /> : <Eye size={14} />}
          </button>
        </div>
        <p className="mt-1 text-[11px] text-[var(--lm-text-muted)]">
          {apiKey.trim() || preserveStoredApiKey ? '设置 API Key 后即可启用。' : '未设置 API Key。'}
        </p>
        {preserveStoredApiKey && (
          <button
            type="button"
            onClick={() => {
              setPreserveStoredApiKey(false)
              setApiKey('')
            }}
            className="mt-1 text-[11px] text-[var(--lm-text-muted)] transition-colors hover:text-red-500"
          >
            清除已保存密钥
          </button>
        )}
      </section>

      {error && <p className="text-[11px] text-red-500">{error}</p>}

      <button
        onClick={handleSave}
        disabled={!canSave}
        className="flex w-full items-center justify-center gap-1.5 rounded-lg bg-[var(--lm-accent)] px-3 py-2 text-[13px] font-medium text-[var(--lm-accent-fg)] transition-colors hover:bg-[var(--lm-accent-hover)] disabled:cursor-not-allowed disabled:opacity-50"
      >
        {saved && <Check size={14} />}
        {saving ? '保存中…' : saved ? '已保存' : '保存'}
      </button>

      {!isNew && providerId !== null && <ProviderModels providerId={providerId} />}
    </div>
  )
}

function ProviderModels({ providerId }: { providerId: string }) {
  const config = useConfigStore((s) => s.config)
  const updateConfig = useConfigStore((s) => s.updateConfig)
  const removeModel = useConfigStore((s) => s.removeModel)

  const [adding, setAdding] = useState(false)
  const [bulkModels, setBulkModels] = useState('')
  const [contextSize, setContextSize] = useState('200000')
  const [editingId, setEditingId] = useState<string | null>(null)
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)
  const [error, setError] = useState('')

  const models = useMemo(() => {
    return Object.entries(config?.models ?? {})
      .filter(([, m]) => m.provider === providerId)
      .sort(([a], [b]) => a.localeCompare(b))
  }, [config, providerId])

  const parsedContext = Number.parseInt(contextSize, 10)
  const bulkIds = useMemo(
    () => bulkModels.split('\n').map((line) => line.trim()).filter(Boolean),
    [bulkModels],
  )
  const conflictIds = useMemo(
    () => bulkIds.filter((alias) => Boolean(config?.models?.[alias])),
    [bulkIds, config],
  )
  const canAdd =
    bulkIds.length > 0 &&
    conflictIds.length === 0 &&
    Number.isInteger(parsedContext) &&
    parsedContext > 0

  const handleAdd = async () => {
    if (!canAdd) return
    setError('')
    try {
      const modelsPatch: NonNullable<LmcodeConfig['models']> = {}
      for (const alias of bulkIds) {
        modelsPatch[alias] = {
          provider: providerId,
          model: alias,
          maxContextSize: parsedContext,
        }
      }
      await updateConfig({
        models: modelsPatch,
        // The desktop has no separate "default model" setting, so the first
        // model added becomes the default; otherwise new sessions created
        // before any manual model pick start with no model and fail.
        ...(config?.defaultModel?.trim() ? {} : { defaultModel: bulkIds[0] }),
      })
      setBulkModels('')
      setContextSize('200000')
      setAdding(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : '添加失败')
    }
  }

  const handleDelete = async (modelId: string) => {
    if (confirmDeleteId !== modelId) {
      setConfirmDeleteId(modelId)
      setTimeout(() => setConfirmDeleteId(null), 3000)
      return
    }
    await removeModel(modelId)
    setConfirmDeleteId(null)
  }

  return (
    <section className="border-t border-[var(--lm-border)] pt-3">
      <div className="mb-2 flex items-baseline justify-between">
        <label className={labelClass}>模型列表</label>
        {models.length > 0 && (
          <span className="text-[11px] text-[var(--lm-text-muted)]">{models.length} 个模型</span>
        )}
      </div>
      {error && <p className="mb-2 text-[11px] text-red-500">{error}</p>}
      <div className="space-y-1.5">
        {models.length === 0 && !adding && (
          <p className="py-1 text-[11px] text-[var(--lm-text-muted)]">
            还没有模型，添加后即可在聊天中选择。
          </p>
        )}
        {models.map(([modelId, m]) =>
          editingId === modelId ? (
            <ModelRowEditor
              key={modelId}
              modelId={modelId}
              model={m}
              onDone={async (patch) => {
                setError('')
                try {
                  await updateConfig({ models: { [modelId]: patch } })
                  setEditingId(null)
                } catch (err) {
                  setError(err instanceof Error ? err.message : '保存失败')
                }
              }}
              onCancel={() => setEditingId(null)}
            />
          ) : (
            <div
              key={modelId}
              className="flex items-center gap-2 rounded-lg border border-[var(--lm-border)] bg-[var(--lm-bg-surface)] px-2.5 py-1.5"
            >
              <div className="flex min-w-0 flex-1 flex-col">
                <span className="truncate text-[12px] font-medium text-[var(--lm-text-primary)]">
                  {m.displayName?.trim() || modelId}
                </span>
                {m.model !== modelId && (
                  <span className="truncate text-[10px] text-[var(--lm-text-muted)]">{m.model}</span>
                )}
              </div>
              <span className="shrink-0 rounded bg-[var(--lm-bg-hover)] px-1.5 py-0.5 text-[10px] text-[var(--lm-text-muted)]">
                {formatContextSize(m.maxContextSize)}
              </span>
              <button
                onClick={() => setEditingId(modelId)}
                className="shrink-0 rounded p-1 text-[var(--lm-text-muted)] transition-colors hover:text-[var(--lm-text-primary)]"
                title="编辑模型配置"
              >
                <Pencil size={12} />
              </button>
              <button
                onClick={() => handleDelete(modelId)}
                className={cn(
                  'shrink-0 rounded p-1 transition-colors',
                  confirmDeleteId === modelId
                    ? 'bg-red-500/15 text-red-500'
                    : 'text-[var(--lm-text-muted)] hover:text-red-500',
                )}
                title={confirmDeleteId === modelId ? '再次点击确认删除' : '删除模型'}
              >
                <Trash2 size={12} />
              </button>
            </div>
          ),
        )}

        {adding ? (
          <div className="space-y-2 rounded-lg border border-[var(--lm-border)] bg-[var(--lm-bg-surface)] p-2.5">
            <textarea
              value={bulkModels}
              onChange={(e) => setBulkModels(e.target.value)}
              placeholder={'每行一个模型名称\n如：k3\nk3-turbo'}
              rows={3}
              className={cn(inputClass, 'resize-none font-mono')}
            />
            {conflictIds.length > 0 && (
              <p className="text-[11px] text-red-500">
                以下模型 ID 已存在：{conflictIds.join('、')}
              </p>
            )}
            <input
              value={contextSize}
              onChange={(e) => setContextSize(e.target.value)}
              placeholder="上下文长度，如 200000"
              inputMode="numeric"
              className={inputClass}
            />
            {error && <p className="text-[11px] text-red-500">{error}</p>}
            <div className="flex gap-2">
              <button
                onClick={handleAdd}
                disabled={!canAdd}
                className="flex-1 rounded-lg bg-[var(--lm-accent)] px-3 py-1.5 text-[12px] font-medium text-[var(--lm-accent-fg)] transition-colors hover:bg-[var(--lm-accent-hover)] disabled:cursor-not-allowed disabled:opacity-50"
              >
                添加
              </button>
              <button
                onClick={() => {
                  setAdding(false)
                  setBulkModels('')
                  setError('')
                }}
                className="rounded-lg px-3 py-1.5 text-[12px] text-[var(--lm-text-muted)] transition-colors hover:bg-[var(--lm-bg-hover)]"
              >
                取消
              </button>
            </div>
          </div>
        ) : (
          <button
            onClick={() => setAdding(true)}
            className="flex w-full items-center justify-center gap-1 rounded-lg border border-dashed border-[var(--lm-border-strong)] px-3 py-1.5 text-[11px] font-medium text-[var(--lm-text-secondary)] transition-colors hover:border-[var(--lm-accent)] hover:text-[var(--lm-text-primary)]"
          >
            <Plus size={12} />
            添加模型
          </button>
        )}
      </div>
    </section>
  )
}

interface ModelRowEditorProps {
  modelId: string
  model: ModelAlias
  onDone: (patch: Partial<ModelAlias>) => void | Promise<void>
  onCancel: () => void
}

/** 编辑单个模型的显示名 / 上游模型名 / 上下文窗口（对齐 ZCode 的「编辑模型配置」）。 */
function ModelRowEditor({ modelId, model, onDone, onCancel }: ModelRowEditorProps) {
  const [displayName, setDisplayName] = useState(model.displayName ?? '')
  const [modelName, setModelName] = useState(model.model === modelId ? '' : model.model)
  const [contextSize, setContextSize] = useState(String(model.maxContextSize))

  const parsedContext = Number.parseInt(contextSize, 10)
  const canSave = Number.isInteger(parsedContext) && parsedContext > 0

  const handleSave = () => {
    if (!canSave) return
    void onDone({
      displayName: displayName.trim(),
      model: modelName.trim() || modelId,
      maxContextSize: parsedContext,
    })
  }

  return (
    <div className="space-y-2 rounded-lg border border-[var(--lm-border)] bg-[var(--lm-bg-surface)] p-2.5">
      <div className="flex items-center justify-between">
        <span className="text-[11px] font-medium text-[var(--lm-text-secondary)]">{modelId}</span>
        <button
          onClick={onCancel}
          className="rounded p-0.5 text-[var(--lm-text-muted)] transition-colors hover:text-[var(--lm-text-primary)]"
          title="取消"
        >
          <X size={12} />
        </button>
      </div>
      <input
        value={displayName}
        onChange={(e) => setDisplayName(e.target.value)}
        placeholder="显示名称（可选）"
        className={inputClass}
      />
      <input
        value={modelName}
        onChange={(e) => setModelName(e.target.value)}
        placeholder="上游模型名（默认同 ID）"
        className={inputClass}
      />
      <input
        value={contextSize}
        onChange={(e) => setContextSize(e.target.value)}
        placeholder="上下文长度，如 200000"
        inputMode="numeric"
        className={inputClass}
      />
      <button
        onClick={handleSave}
        disabled={!canSave}
        className="flex w-full items-center justify-center gap-1 rounded-lg bg-[var(--lm-accent)] px-3 py-1.5 text-[12px] font-medium text-[var(--lm-accent-fg)] transition-colors hover:bg-[var(--lm-accent-hover)] disabled:cursor-not-allowed disabled:opacity-50"
      >
        <Check size={12} />
        保存
      </button>
    </div>
  )
}
