/**
 * agent 工具：plugin_search（市场检索）+ plugin_health（环境体检）。
 *
 * 归属：A 类·重写（注册官方工具面；旧 src/tools.ts 仅作意图参考，未复制代码）。
 * 旧实现参考：dsh-web-plugin-manager/src/tools.ts（365 行：defineTool 的用法、
 *   文本渲染形态、plugin_search 的"安装前先浏览仓库"提示、空查询按星数兜底）。
 * 官方复用：@deepseek-ai/dsh-tools 的 defineTool + ctx.tools.register（与官方
 *   plugin_manager 工具同一套注册面）。
 * 前提检查：**用户决定删掉了旧实现的四个工具**——"agent 工具只留 plugin_search +
 *   健康检查，其余交还官方"。旧 plugin_status / plugin_install / plugin_uninstall /
 *   plugin_toggle 的前提（官方没有当前环境管理能力）在 0.1.6 之后消失：官方
 *   plugin_manager 工具已覆盖列出/启停/安装/卸载四个动作，再注册一份同名能力
 *   只会造成两个入口两套语义。因此本模块只提供官方**没有**的两件事：
 *   市场语义检索（官方没有市场概念）与环境体检（官方不做深度诊断）。
 *
 * 依赖注入而不是静态 import：本模块要用的 match（打分）与 diagnostics（诊断引擎）
 * 由同一仓库的其他模块提供，它们的导出面定稿之前静态 import 会让**整个 host 构建**
 * 编译不过（tsc 一次编译 src 下所有 .ts）。所以这里把两者声明成可注入的能力
 * （CompanionToolsHost），由装配点传进来——旧实现用同样的手法避免与 index.ts 循环
 * import，这里顺带把"构建顺序"也解耦了。
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Context } from '@deepseek-ai/cordis'
import { DEFAULT_CONFIG, type CompanionConfig } from './settings.ts'
import type { DiagnosticReport, EnvironmentInfo, MarketItem } from './types.ts'

/** 市场检索的返回：索引条目、索引生成时间、命中数量。 */
export interface SearchLookup {
  readonly items: readonly MarketItem[]
  readonly generatedAt: string
  /** 索引里的条目总数（含未命中项），用于告诉用户"扫了多少条"。 */
  readonly total?: number
}

/**
 * 注入给工具的宿主能力。
 *
 * 装配点负责把真实实现接上：
 *   - market：市场索引读取（marketplace.ts）；
 *   - rank：纯函数打分（match.ts）——工具本身不做打分决策，只负责把它排出来的
 *     顺序与上限交给模型；
 *   - analyze：诊断引擎（diagnostics.ts）；
 *   - environment：当前环境事实（envManager.ts）。
 * 任何一项缺失时，对应工具仍会注册，但执行时抛出**可读**的缺失原因（绝不返回
 * 一个"看起来健康"的空结果）。
 */
export interface CompanionToolsHost {
  /** 读市场索引；refresh 为 true 时强制走网络。 */
  readonly market: (options: { readonly refresh: boolean }) => Promise<SearchLookup>
  /** 自然语言检索打分：返回按相关度排好序的条目（调用方再截断上限）。 */
  readonly rank: (items: readonly MarketItem[], query: string) => readonly MarketItem[]
  /** 跑一次环境体检。ctx 为 undefined 时引擎应记 skipped 而不是崩溃。 */
  readonly analyze: (
    ctx: Context | undefined,
    environment: EnvironmentInfo | undefined,
    config: CompanionConfig,
  ) => Promise<DiagnosticReport>
  /** 当前环境事实；不可用时 undefined。 */
  readonly environment?: () => EnvironmentInfo | undefined
  /** 本插件配置；不可用时用默认配置。 */
  readonly config?: () => CompanionConfig
}

/** 检索结果里每条最多展示的 topic 数（多了会把一行撑爆）。 */
const MAX_TOPICS = 3

/**
 * 渲染检索结果所需的最小字段集。
 *
 * 刻意不用 wire 类型 MarketItem：工具输出是它自己的投影（少几个字段、stars 用
 * 可选表达未知），让渲染函数按它真正读到的字段声明入参，比硬套一个大类型更能
 * 保证两者一起演进。
 */
export interface SearchRow {
  readonly repo: string
  readonly name: string
  readonly description: string
  /** 星数；未知时 null（与 src/types.ts 的 MarketItem 契约一致：null 表达未知，而不是缺键）。 */
  readonly stars: number | null
  readonly topics: readonly string[]
  readonly installed: boolean
  readonly installedVersion?: string
  readonly latestVersion?: string
}

/** 结果条数上限（模型侧一次性看到的候选）。 */
export const SEARCH_LIMIT_MAX = 10

/** 结果条数下限。 */
export const SEARCH_LIMIT_MIN = 1

/** 默认结果条数。 */
export const SEARCH_LIMIT_DEFAULT = 5

/** 健康检查里最多带上的问题条数（细节在 UI 里看；工具输出要控制 token）。 */
export const HEALTH_ISSUE_LIMIT = 20

/**
 * 把检索结果渲染成模型可读文本。
 *
 * 最后一句"安装前先浏览仓库"是刻意的固定文案：索引元数据（星数/topic/描述）
 * 判断不了质量，而安装会执行第三方代码。工具描述里也说了一遍，因为模型可能
 * 只看渲染结果。
 *
 * @param matches - 已排序、已截断的候选。
 * @param query - 原始查询（空查询时提示这是"按热度兜底"）。
 * @returns 文本行。
 */
export function renderSearchText(matches: readonly SearchRow[], query: string): string {
  if (matches.length === 0) {
    return query === ''
      ? 'The marketplace index returned no entries. Check that the index is enabled in the companion settings, or run plugin_search again later.'
      : 'No marketplace entry matched "' + query + '". Try broader terms (for example image, terminal, memory, rag).'
  }
  const lines = matches.map((item, index) => {
    const state = item.installed
      ? ' [installed' + (item.installedVersion === undefined ? '' : ' ' + item.installedVersion) + ']'
      : ''
    const latest = item.latestVersion === undefined ? '' : '  latest ' + item.latestVersion
    const topics = item.topics.length > 0 ? '  [' + item.topics.slice(0, MAX_TOPICS).join(', ') + ']' : ''
    const stars = item.stars === null ? '' : '  ' + String(item.stars) + ' stars'
    return String(index + 1) + '. ' + item.name + ' (' + item.repo + ')'
      + '\n   ' + (item.description === '' ? '(no description)' : item.description)
      + '\n   https://github.com/' + item.repo + stars + topics + latest + state
  })
  return lines.join('\n\n')
    + '\n\nReview the repository before installing: marketplace metadata cannot judge quality, and '
    + 'installation runs third-party code. To install, call plugin_manager with action "install_bundle" '
    + 'and the package spec (it requires danger-full-access permission or approval).'
}

/**
 * 把体检报告渲染成模型可读文本。
 * @param report - 诊断报告。
 * @returns 文本行。
 */
export function renderHealthText(report: DiagnosticReport): string {
  const layers = Object.entries(countsOf(report))
    .filter(([, count]) => count > 0)
    .map(([layer, count]) => layer + '=' + String(count))
  const header = 'Environment "' + report.environment + '" checked at ' + report.generatedAt
    + '; issues: ' + String(report.issues.length)
    + (layers.length === 0 ? '' : ' (' + layers.join(', ') + ')')
  const lines = report.issues.slice(0, HEALTH_ISSUE_LIMIT).map(issue => {
    const fix = issue.fix === undefined ? '' : '\n   fix: ' + issue.fix.action + ' — ' + issue.fix.summary
    const evidence = issue.evidence.slice(0, 2).map(item => item.at + ' (' + item.note + ')').join('; ')
    return '[' + issue.severity + '] ' + issue.code + ': ' + issue.title
      + '\n   ' + issue.detail
      + (evidence === '' ? '' : '\n   evidence: ' + evidence)
      + fix
  })
  const more = report.issues.length > HEALTH_ISSUE_LIMIT
    ? '\n\n(' + String(report.issues.length - HEALTH_ISSUE_LIMIT) + ' more issues omitted; open the companion environment console for the full report.)'
    : ''
  const skipped = report.skipped.length > 0
    ? '\n\nSkipped checks (capability missing, reported honestly): '
      + report.skipped.map(item => item.check + ' — ' + item.reason).join('; ')
    : ''
  const body = lines.length > 0 ? '\n\n' + lines.join('\n\n') : '\n\nNo issues found.'
  return header + body + more + skipped
}

/** 各诊断层的问题数。用具名字段而不是 Record，因为工具输出 schema 是显式枚举。 */
export interface LayerCounts {
  readonly dependency: number
  readonly composition: number
  readonly runtime: number
  readonly consistency: number
  readonly ecosystem: number
}

/** 从报告里取各层计数。 */
function countsOf(report: DiagnosticReport): LayerCounts {
  return {
    dependency: report.counts.dependency,
    composition: report.counts.composition,
    runtime: report.counts.runtime,
    consistency: report.counts.consistency,
    ecosystem: report.counts.ecosystem,
  }
}

/** 体检工具的输出值（lossless JSON；可选键用 undefined 省略而不是 null）。 */
interface HealthValue {
  readonly environment: string
  readonly generatedAt: string
  readonly summary: string
  counts: LayerCounts
  /** 问题列表。这里全部用可变类型：defineTool 从 schema 推断出的输出类型没有 readonly，
      工具返回值必须能直接对上；报告的只读契约由 DiagnosticReport 那一侧保证。 */
  issues: {
    id: string
    layer: string
    severity: string
    code: string
    title: string
    detail: string
    subjects: string[]
    evidence: { at: string; note: string }[]
    fix?: { action: string; target?: string; summary: string }
  }[]
  skipped: { check: string; reason: string }[]
}

/** 体检报告的投影：保留模型决策需要的字段，丢掉 UI 专用的量。 */
function healthValueOf(report: DiagnosticReport): HealthValue {
  return {
    environment: report.environment,
    generatedAt: report.generatedAt,
    summary: report.issues.length === 0
      ? 'no issues found'
      : String(report.issues.length) + ' issue(s): ' + Object.entries(countsOf(report))
        .filter(([, count]) => count > 0)
        .map(([layer, count]) => layer + '=' + String(count))
        .join(', '),
    counts: countsOf(report),
    issues: report.issues.slice(0, HEALTH_ISSUE_LIMIT).map(issue => ({
      id: issue.id,
      layer: issue.layer,
      severity: issue.severity,
      code: issue.code,
      title: issue.title,
      detail: issue.detail,
      subjects: [...issue.subjects],
      evidence: issue.evidence.map(item => ({ at: item.at, note: item.note })),
      ...issue.fix === undefined ? {} : { fix: { ...issue.fix } },
    })),
    skipped: report.skipped.map(item => ({ check: item.check, reason: item.reason })),
  }
}

/** 工具定义的可注册数组类型（defineTool 的返回结构对调用方不透明）。 */
type RegisteredTool = ReturnType<typeof defineTool>

/**
 * 构造两个工具定义（不注册）。
 *
 * 导出它而不是只导出注册函数的原因：测试可以直接对工具定义跑 execute，验证
 * "上限、排序、缺失能力时的报错"这些决策，而不必造一个假的 Cordis 上下文。
 *
 * @param host - 注入的宿主能力。
 * @returns 工具定义数组。
 */
export function createCompanionTools(host: CompanionToolsHost): RegisteredTool[] {
  const configOf = (): CompanionConfig => host.config?.() ?? DEFAULT_CONFIG

  return [
    defineTool({
      name: 'plugin_search',
      description: 'Search the DSH plugin marketplace for plugins that match a need, in natural language '
        + '("OCR screenshots", "memory rag", "terminal UI"; Chinese and English both work). Returns candidate '
        + 'repositories with stars, topics, description and install state. Marketplace metadata cannot judge '
        + 'quality: advise the user to review the repository before installing. To install a result, use the '
        + 'plugin_manager tool with action "install_bundle". Use this when the user wants to find or compare '
        + 'DSH plugins.',
      parameters: {
        query: { type: 'string', required: true, description: 'What the user wants, e.g. "OCR screenshots", "memory rag".' },
        limit: { type: 'number', description: 'Maximum number of results (1-10, default 5).' },
        refresh: { type: 'boolean', description: 'Force a marketplace index refresh instead of using the cache. Defaults to false.' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            query: { type: 'string', required: true },
            generatedAt: { type: 'string', required: true },
            indexed: { type: 'number', required: true },
            matches: {
              type: 'array',
              required: true,
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  repo: { type: 'string', required: true },
                  name: { type: 'string', required: true },
                  description: { type: 'string', required: true },
                  stars: { oneOf: [{ type: 'number' }, { type: 'null' }], required: true },
                  topics: { type: 'array', items: { type: 'string' }, required: true },
                  installed: { type: 'boolean', required: true },
                  installedVersion: { type: 'string' },
                  latestVersion: { type: 'string' },
                },
              },
            },
          },
        },
        render: (_args, value) => [{
          type: 'text',
          text: renderSearchText(value.matches.map(match => ({
            repo: match.repo,
            name: match.name,
            description: match.description,
            stars: match.stars ?? null,
            updatedAt: null,
            topics: match.topics,
            installed: match.installed,
            ...match.installedVersion === undefined ? {} : { installedVersion: match.installedVersion },
            ...match.latestVersion === undefined ? {} : { latestVersion: match.latestVersion },
          })), value.query),
        }],
      },
      async execute(args) {
        const raw = typeof args.limit === 'number' && Number.isFinite(args.limit) ? Math.trunc(args.limit) : SEARCH_LIMIT_DEFAULT
        const limit = Math.min(Math.max(SEARCH_LIMIT_MIN, raw), SEARCH_LIMIT_MAX)
        const query = String(args.query ?? '').trim()
        const lookup = await host.market({ refresh: args.refresh === true })
        // 空查询不报错：match.ts 的回退语义是"按热度给前 N 条"，这对
        // "有什么插件"这类探索性提问正是想要的（旧实现在这里是抛错）。
        const ranked = host.rank(lookup.items, query)
        const matches = ranked.slice(0, limit).map(item => ({
          repo: item.repo,
          name: item.name,
          description: item.description,
          stars: item.stars,
          topics: item.topics.slice(0, MAX_TOPICS),
          installed: item.installed === true,
          ...item.installedVersion === undefined ? {} : { installedVersion: item.installedVersion },
          ...item.latestVersion === undefined ? {} : { latestVersion: item.latestVersion },
        }))
        return {
          query,
          generatedAt: lookup.generatedAt,
          indexed: lookup.total ?? lookup.items.length,
          matches,
        }
      },
      presentCall: args => ({
        card: 'generic',
        title: 'Search the plugin marketplace',
        kind: 'read',
        rawInput: args,
      }),
    }),

    defineTool({
      name: 'plugin_health',
      description: 'Run a deep health check of the local DSH environment and return a structured summary: '
        + 'dependency problems, composition problems (duplicate row ids, disabled dependencies), runtime '
        + 'problems (failed or long-pending plugin fibers, service/tool name conflicts), and consistency '
        + 'problems between the installed files and what is actually loaded. Every finding carries evidence '
        + '(a file and line, or a loader entry) and, when a safe fix exists, the action to take. Use this '
        + 'when the user reports a plugin that will not load, a profile that will not start, or asks for a '
        + 'health check. Read-only: it never changes the environment.',
      parameters: {
        layer: {
          type: 'string',
          enum: ['dependency', 'composition', 'runtime', 'consistency', 'ecosystem'],
          description: 'Report only one diagnostic layer. Omit for every enabled layer.',
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            environment: { type: 'string', required: true },
            generatedAt: { type: 'string', required: true },
            summary: { type: 'string', required: true },
            counts: {
              type: 'object',
              required: true,
              additionalProperties: false,
              properties: {
                dependency: { type: 'number', required: true },
                composition: { type: 'number', required: true },
                runtime: { type: 'number', required: true },
                consistency: { type: 'number', required: true },
                ecosystem: { type: 'number', required: true },
              },
            },
            issues: {
              type: 'array',
              required: true,
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  id: { type: 'string', required: true },
                  layer: { type: 'string', required: true },
                  severity: { type: 'string', required: true },
                  code: { type: 'string', required: true },
                  title: { type: 'string', required: true },
                  detail: { type: 'string', required: true },
                  subjects: { type: 'array', items: { type: 'string' }, required: true },
                  evidence: {
                    type: 'array',
                    required: true,
                    items: {
                      type: 'object',
                      additionalProperties: false,
                      properties: {
                        at: { type: 'string', required: true },
                        note: { type: 'string', required: true },
                      },
                    },
                  },
                  fix: {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                      action: { type: 'string', required: true },
                      target: { type: 'string' },
                      summary: { type: 'string', required: true },
                    },
                  },
                },
              },
            },
            skipped: {
              type: 'array',
              required: true,
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  check: { type: 'string', required: true },
                  reason: { type: 'string', required: true },
                },
              },
            },
          },
        },
        render: (_args, value) => [{
          type: 'text',
          text: renderHealthText({
            environment: value.environment,
            generatedAt: value.generatedAt,
            counts: value.counts,
            issues: value.issues.map(issue => ({
              id: issue.id,
              layer: issue.layer as DiagnosticReport['issues'][number]['layer'],
              severity: issue.severity as DiagnosticReport['issues'][number]['severity'],
              code: issue.code,
              title: issue.title,
              detail: issue.detail,
              subjects: [...issue.subjects],
              evidence: issue.evidence.map(item => ({ kind: 'file' as const, at: item.at, note: item.note })),
              ...issue.fix === undefined ? {} : { fix: issue.fix },
            })),
            skipped: value.skipped,
          }),
        }],
      },
      async execute(args) {
        const config = configOf()
        const report = await host.analyze(undefined, host.environment?.(), config)
        const filtered = args.layer === undefined
          ? report
          : {
            ...report,
            issues: report.issues.filter(issue => issue.layer === args.layer),
            counts: countsOf(report),
          }
        return healthValueOf(filtered)
      },
      presentCall: args => ({
        card: 'generic',
        title: 'Run an environment health check',
        kind: 'read',
        rawInput: args,
      }),
    }),
  ]
}

/**
 * 注册两个工具（tools 服务缺失时返回空数组，插件仍能加载）。
 *
 * @param ctx - host 上下文。
 * @param host - 注入的宿主能力。
 * @returns 注销函数数组。
 */
export function registerCompanionTools(ctx: Context, host: CompanionToolsHost): (() => void)[] {
  const tools = ctx.get('tools') as { register(definition: RegisteredTool): () => void } | undefined
  if (tools === undefined || typeof tools.register !== 'function') {
    ctx.logger?.info?.('plugin-manager-companion: tools service unavailable, agent tools not registered')
    return []
  }
  return createCompanionTools(host).map(definition => tools.register(definition))
}
