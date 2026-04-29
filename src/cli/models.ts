/**
 * Known Claude model IDs and aliases. The SDK accepts short aliases
 * (opus, sonnet, haiku) or full IDs (claude-opus-4-7, ...). We use this
 * list both for /model autocomplete-style suggestions and for normalising
 * common typos like 'opus-4.6' -> 'claude-opus-4-6'.
 */

export interface KnownModel {
  id: string
  alias?: string
  description?: string
}

export const KNOWN_MODELS: KnownModel[] = [
  { id: 'claude-opus-4-7', alias: 'opus', description: 'flagship — best reasoning, slowest' },
  { id: 'claude-opus-4-6', description: 'previous opus revision' },
  { id: 'claude-sonnet-4-6', alias: 'sonnet', description: 'balanced default for coding' },
  { id: 'claude-haiku-4-5', alias: 'haiku', description: 'fastest, cheapest, classification/summary' },
]

/**
 * Normalise user input to a likely-valid SDK model string. Returns the
 * resolved value (alias kept as-is, full IDs corrected for `.`/missing
 * prefix) and a flag indicating whether it matches a known entry.
 */
export function resolveModel(input: string): { model: string; known: boolean } {
  const raw = input.trim()
  if (!raw) return { model: '', known: false }

  const aliasHit = KNOWN_MODELS.find((k) => k.alias === raw)
  if (aliasHit) return { model: raw, known: true }

  if (KNOWN_MODELS.some((k) => k.id === raw)) {
    return { model: raw, known: true }
  }

  // typo: dots instead of dashes ('opus-4.6' / 'claude-opus-4.6')
  const dashed = raw.replace(/\./g, '-')
  if (KNOWN_MODELS.some((k) => k.id === dashed)) {
    return { model: dashed, known: true }
  }

  // missing 'claude-' prefix ('opus-4-6' / 'opus-4.6')
  if (!dashed.startsWith('claude-')) {
    const prefixed = 'claude-' + dashed
    if (KNOWN_MODELS.some((k) => k.id === prefixed)) {
      return { model: prefixed, known: true }
    }
  }

  // Pass through anything else — Anthropic may release IDs we don't know.
  return { model: dashed, known: false }
}

export function formatKnownModels(): string {
  const lines = ['Known models:']
  for (const m of KNOWN_MODELS) {
    const alias = m.alias ? `  alias: ${m.alias}` : ''
    const desc = m.description ? `  ${m.description}` : ''
    lines.push(`  ${m.id}${alias}${desc}`)
  }
  return lines.join('\n')
}
