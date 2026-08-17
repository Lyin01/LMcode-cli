import type {
  PluginInfo,
  PluginSummary,
  ReloadSummary,
} from '@lmcode-cli/lmcode-sdk'
import type { DesktopHandlerContext } from '../handler-context.js'

/**
 * Extensibility surfaces: skills, MCP servers and plugins. All three are
 * session-scoped — they are forwarded to the active SDK session.
 */
export function registerExtensionHandlers(ctx: DesktopHandlerContext): void {
  const { secureInvoke } = ctx

  // ── Skills ──────────────────────────────────────────────────────

  secureInvoke('lmcode:listSkills', async (_event, sessionId: string): Promise<unknown> => {
    const entry = await ctx.ensureActiveSession(sessionId)
    return entry.session.listSkills()
  })

  secureInvoke('lmcode:activateSkill', async (_event, sessionId: string, name: string, args?: string): Promise<void> => {
    const entry = await ctx.ensureActiveSession(sessionId)
    await entry.session.activateSkill(name, args)
  })

  // ── MCP servers ─────────────────────────────────────────────────

  secureInvoke('lmcode:listMcpServers', async (_event, sessionId: string): Promise<unknown> => {
    const entry = await ctx.ensureActiveSession(sessionId)
    return entry.session.listMcpServers()
  })

  secureInvoke('lmcode:reconnectMcpServer', async (_event, sessionId: string, name: string): Promise<void> => {
    const entry = await ctx.ensureActiveSession(sessionId)
    await entry.session.reconnectMcpServer(name)
  })

  secureInvoke('lmcode:addMcpServer', async (_event, sessionId: string, name: string, config: Record<string, unknown>): Promise<void> => {
    const entry = await ctx.ensureActiveSession(sessionId)
    await entry.session.addMcpServer(name, config)
  })

  secureInvoke('lmcode:stopMcpServer', async (_event, sessionId: string, name: string): Promise<void> => {
    const entry = await ctx.ensureActiveSession(sessionId)
    await entry.session.stopMcpServer(name)
  })

  secureInvoke('lmcode:removeMcpServer', async (_event, sessionId: string, name: string): Promise<void> => {
    const entry = await ctx.ensureActiveSession(sessionId)
    await entry.session.removeMcpServer(name)
  })

  // ── Plugins ─────────────────────────────────────────────────────

  secureInvoke('lmcode:listPlugins', async (_event, sessionId: string): Promise<readonly PluginSummary[]> => {
    const entry = await ctx.ensureActiveSession(sessionId)
    return entry.session.listPlugins()
  })

  secureInvoke('lmcode:installPlugin', async (_event, sessionId: string, source: string): Promise<PluginSummary> => {
    const entry = await ctx.ensureActiveSession(sessionId)
    return entry.session.installPlugin(source)
  })

  secureInvoke('lmcode:setPluginEnabled', async (_event, sessionId: string, id: string, enabled: boolean): Promise<void> => {
    const entry = await ctx.ensureActiveSession(sessionId)
    await entry.session.setPluginEnabled(id, enabled)
  })

  secureInvoke('lmcode:setPluginMcpServerEnabled', async (_event, sessionId: string, id: string, server: string, enabled: boolean): Promise<void> => {
    const entry = await ctx.ensureActiveSession(sessionId)
    await entry.session.setPluginMcpServerEnabled(id, server, enabled)
  })

  secureInvoke('lmcode:removePlugin', async (_event, sessionId: string, id: string): Promise<void> => {
    const entry = await ctx.ensureActiveSession(sessionId)
    await entry.session.removePlugin(id)
  })

  secureInvoke('lmcode:reloadPlugins', async (_event, sessionId: string): Promise<ReloadSummary> => {
    const entry = await ctx.ensureActiveSession(sessionId)
    return entry.session.reloadPlugins()
  })

  secureInvoke('lmcode:getPluginInfo', async (_event, sessionId: string, id: string): Promise<PluginInfo> => {
    const entry = await ctx.ensureActiveSession(sessionId)
    return entry.session.getPluginInfo(id)
  })
}
