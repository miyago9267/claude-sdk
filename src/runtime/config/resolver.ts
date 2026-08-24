import type { ConfigDiagnostic, ConfigLayer, ResolvedRuntimeConfig, RuntimeConfig } from './types.ts'

const SCALAR_FIELDS: Array<keyof RuntimeConfig> = [
  'model',
  'fallbackModels',
  'reasoningEffort',
  'sandboxMode',
  'approvalPolicy',
]

export function resolveRuntimeConfig(layers: ConfigLayer[]): ResolvedRuntimeConfig {
  const config: RuntimeConfig = {}
  const diagnostics: ConfigDiagnostic[] = []
  const sources: string[] = []

  for (const layer of layers) {
    sources.push(layer.source)
    diagnostics.push(...(layer.diagnostics ?? []))
    for (const field of SCALAR_FIELDS) {
      const value = layer.config[field]
      if (value === undefined) continue
      if (config[field] !== undefined && JSON.stringify(config[field]) !== JSON.stringify(value)) {
        diagnostics.push({
          level: 'warning',
          code: 'override',
          field,
          source: layer.source,
          message: `${field} from ${layer.source} overrides an earlier value`,
        })
      }
      ;(config as Record<string, unknown>)[field] = Array.isArray(value) ? [...value] : value
    }
    for (const [key, value] of Object.entries(layer.config.environment ?? {})) {
      if (config.environment?.[key] !== undefined && config.environment[key] !== value) {
        diagnostics.push({
          level: 'warning',
          code: 'override',
          field: `environment.${key}`,
          source: layer.source,
          message: `environment.${key} from ${layer.source} overrides an earlier value`,
        })
      }
      config.environment = { ...(config.environment ?? {}), [key]: value }
    }
  }

  return { config, sources, diagnostics }
}
