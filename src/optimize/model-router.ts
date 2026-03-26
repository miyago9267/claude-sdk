/**
 * Model Router -- Automatic model selection based on task category.
 *
 * Routes tasks to the most cost-effective model that can handle them:
 * - Coordinator/Architect -> Opus (needs deep reasoning)
 * - Implementation -> Sonnet (good balance of cost/capability)
 * - Validation/Classification/Summarization -> Haiku (fast, cheap)
 */

import type {
  ModelRouterConfig,
  ModelRoutingRule,
  TaskCategory,
} from './types.js'
import { DEFAULT_ROUTER_CONFIG } from './types.js'

export interface RoutingResult {
  model: string
  effort?: 'low' | 'medium' | 'high' | 'max'
  matchedRule: ModelRoutingRule | null
}

/**
 * Create a model router instance with the given configuration.
 */
export function createModelRouter(userConfig?: Partial<ModelRouterConfig>) {
  const config: ModelRouterConfig = {
    ...DEFAULT_ROUTER_CONFIG,
    ...userConfig,
    rules: userConfig?.rules ?? DEFAULT_ROUTER_CONFIG.rules,
  }

  /**
   * Route a task category to the appropriate model.
   */
  function route(category: TaskCategory): RoutingResult {
    for (const rule of config.rules) {
      if (rule.categories.includes(category)) {
        return {
          model: rule.model,
          effort: rule.effort,
          matchedRule: rule,
        }
      }
    }

    return {
      model: config.defaultModel,
      effort: undefined,
      matchedRule: null,
    }
  }

  /**
   * Infer task category from agent name or description using keyword matching.
   * Returns 'general' if no category can be inferred.
   */
  function inferCategory(agentNameOrDescription: string): TaskCategory {
    const text = agentNameOrDescription.toLowerCase()

    const patterns: Array<{ category: TaskCategory; keywords: string[] }> = [
      {
        category: 'coordinator',
        keywords: ['coordinator', 'orchestrat', 'manage', 'plan', 'delegate'],
      },
      {
        category: 'architect',
        keywords: ['architect', 'design', 'structure'],
      },
      {
        category: 'validation',
        keywords: ['valid', 'test', 'check', 'verify', 'review', 'lint', 'qa'],
      },
      {
        category: 'implementation',
        keywords: ['implement', 'code', 'develop', 'build', 'engineer'],
      },
      {
        category: 'classification',
        keywords: ['classif', 'categoriz', 'sort', 'triage', 'route'],
      },
      {
        category: 'summarization',
        keywords: ['summar', 'digest', 'recap', 'compress', 'condense'],
      },
    ]

    for (const { category, keywords } of patterns) {
      if (keywords.some(kw => text.includes(kw))) {
        return category
      }
    }

    return 'general'
  }

  /**
   * Route by agent name/description, auto-inferring category.
   */
  function routeByDescription(agentNameOrDescription: string): RoutingResult {
    const category = inferCategory(agentNameOrDescription)
    return route(category)
  }

  return {
    route,
    inferCategory,
    routeByDescription,
    config,
  }
}

export type ModelRouter = ReturnType<typeof createModelRouter>
