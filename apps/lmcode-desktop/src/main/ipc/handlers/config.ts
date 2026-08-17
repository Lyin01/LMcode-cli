import type {
  LmcodeConfig,
  LmcodeConfigPatch,
} from '@lmcode-cli/lmcode-sdk'
import {
  restoreRedactedConfigPatch,
  sanitizeConfigForRenderer,
} from '../../config-security.js'
import type { ProviderUsageSnapshot } from '../../../shared/provider-usage-types.js'
import type { DesktopHandlerContext } from '../handler-context.js'

/**
 * Configuration surface: reading/sanitizing config, provider usage querying,
 * and config patches (with redaction restored on the main side).
 */
export function registerConfigHandlers(ctx: DesktopHandlerContext): void {
  const { harness, secureInvoke } = ctx

  secureInvoke('lmcode:getConfig', async (): Promise<LmcodeConfig> => {
    return sanitizeConfigForRenderer(await harness.getConfig())
  })

  secureInvoke(
    'lmcode:getProviderUsage',
    async (_event, force: unknown): Promise<ProviderUsageSnapshot> => {
      return ctx.providerUsage.get(force === true)
    },
  )

  secureInvoke('lmcode:setConfig', async (_event, patch: LmcodeConfigPatch): Promise<LmcodeConfig> => {
    const current = await harness.getConfig()
    const config = await harness.setConfig(restoreRedactedConfigPatch(patch, current))
    ctx.providerUsage.invalidate()
    ctx.auditLog?.info('desktop critical operation completed', {
      operation: 'provider-config.update',
    })
    return sanitizeConfigForRenderer(config)
  })

  secureInvoke('lmcode:removeProvider', async (_event, providerId: string): Promise<LmcodeConfig> => {
    const config = await harness.removeProvider(providerId)
    ctx.providerUsage.invalidate()
    ctx.auditLog?.info('desktop critical operation completed', {
      operation: 'provider-config.remove',
    })
    return sanitizeConfigForRenderer(config)
  })

  secureInvoke('lmcode:removeModel', async (_event, modelId: string): Promise<LmcodeConfig> => {
    return sanitizeConfigForRenderer(await harness.removeModel(modelId))
  })
}
