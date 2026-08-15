/**
 * The spike's mock financial tool: stock code in, announcement titles out.
 *
 * This file is deliberately written the way a real Meridian skill would be:
 * plain TypeScript, zero imports from `@deepseek-ai/*`, and no awareness of
 * which kernel will execute it. It is the proof object for the boundary rule —
 * if this file ever needed a dsh type, the abstraction would have failed.
 *
 * Data is hard-coded (spec-meridian-s1 §3.3). Titles are realistic public
 * A-share announcement headlines; they carry no numbers, so a number-fidelity
 * check on the summary has an unambiguous gold standard.
 *
 * @module test/fixtures/announcements-tool
 */

import type { JsonValue, ToolDefinition } from '../../src/kernel.ts'

/**
 * One announcement row. A `type` alias rather than an `interface` on purpose:
 * only type aliases are structurally assignable to the `JsonValue` index
 * signature the kernel seam requires of every tool result.
 */
export type Announcement = {
  date: string
  title: string
}

/** The tool's canonical return shape. */
export type AnnouncementResult = {
  symbol: string
  name: string
  announcements: Announcement[]
}

/** Hard-coded corpus, keyed by A-share code. */
export const ANNOUNCEMENTS: Record<string, { name: string; rows: Announcement[] }> = {
  '000001': {
    name: '平安银行',
    rows: [
      { date: '2026-08-12', title: '关于全资子公司完成工商变更登记的公告' },
      { date: '2026-08-08', title: '第十三届董事会第七次会议决议公告' },
      { date: '2026-07-30', title: '关于调整部分募集资金投资项目实施进度的公告' },
    ],
  },
  '600519': {
    name: '贵州茅台',
    rows: [
      { date: '2026-08-11', title: '关于控股股东增持公司股份计划实施完毕的公告' },
      { date: '2026-08-05', title: '关于召开2026年第二次临时股东大会的通知' },
    ],
  },
}

/** Distinctive keyword of each corpus title, for assertion without full-text match. */
export const TITLE_KEYWORDS: Record<string, string[]> = {
  '000001': ['工商变更', '董事会', '募集资金'],
  '600519': ['增持', '临时股东大会'],
}

/**
 * The spike prompt. Identical on every kernel — that is the point. Lives beside
 * the tool rather than in the suite so non-test consumers (`scripts/spike-dsh.ts`)
 * can import it without pulling in vitest.
 */
export const SPIKE_PROMPT =
  '请调用工具 list_announcements 查询股票代码 000001 的最近公告，' +
  '然后逐字列出返回的公告标题，并用一句话总结这些公告主要涉及什么。'

/** Calls this tool received, in order — the spike's independent witness. */
export const callLog: Array<Record<string, JsonValue>> = []

/** Reset {@link callLog} between tests. */
export function resetCallLog(): void {
  callLog.length = 0
}

/**
 * The mock financial tool. One required string parameter, one JSON result.
 *
 * @returns a `ToolDefinition` registrable on any {@link AgentKernel}.
 */
export const announcementsTool: ToolDefinition<{ symbol: string }, AnnouncementResult> = {
  name: 'list_announcements',
  description:
    '查询某只 A 股股票最近的公告标题列表。输入 6 位股票代码（如 000001），返回该股票名称与最近公告的日期和标题。' +
    'Look up recent exchange-filing titles for one A-share stock by its 6-digit code.',
  inputSchema: {
    type: 'object',
    properties: {
      symbol: { type: 'string', description: '6 位 A 股股票代码，例如 000001' },
    },
    required: ['symbol'],
    additionalProperties: false,
  },
  execute(args) {
    callLog.push({ ...args })
    const symbol = String(args.symbol).trim()
    const entry = ANNOUNCEMENTS[symbol]
    if (!entry) {
      throw new Error(`unknown symbol: ${symbol}`)
    }
    return { symbol, name: entry.name, announcements: entry.rows }
  },
}
