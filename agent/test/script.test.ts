/**
 * Cross-script matching, and the line it must not cross.
 *
 * Two properties are load-bearing. Internally, a traditional question and a
 * simplified filing have to compare equal, or the pipeline reports a fact the
 * document plainly states as undisclosed. Externally, nothing folded may ever
 * be published: a quote is the filing's own characters, and a memo that quietly
 * rewrote a filing's glyphs would be misquoting it.
 */

import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { locateQuote } from '../src/verify/evidence.ts'
import { detectUnitHints, extractNumbers } from '../src/verify/numbers.ts'
import { FOLD_SIZE, foldScript, matchesScript, scriptMix } from '../src/verify/script.ts'
import { candidatePassages, coverage, touchesTopic } from '../src/verify/text.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const TASKS_DIR = join(HERE, '..', '..', 'bench', 'tasks')

test('the fold is length-preserving and idempotent', () => {
  // Length preservation is what lets a match found in folded text be sliced out
  // of the original: every offset means the same thing in both strings.
  const samples = [
    '支付交易對價的 60%，即人民幣 11,400 萬元',
    '公司計提各項減值準備共計 8,815.45 萬元',
    'Mixed 中文 and ASCII 12,345.67',
    '',
  ]
  for (const sample of samples) {
    const folded = foldScript(sample)
    assert.equal(folded.length, sample.length, `length changed: ${sample}`)
    assert.equal(foldScript(folded), folded, `not idempotent: ${sample}`)
  }
  assert.ok(FOLD_SIZE > 2000, 'a table this small would not cover a filing')
})

test('every glyph difference the benchmark itself uses is folded', () => {
  // The zh-TW task prompts are character-for-character conversions of the zh-CN
  // ones, which makes them a free correctness fixture — and prompts, not gold,
  // so nothing here can leak an answer.
  const pairs = new Map<string, string>()
  for (const id of readdirSync(TASKS_DIR)) {
    const traditional = join(TASKS_DIR, id, 'task.zh-TW.json')
    const simplified = join(TASKS_DIR, id, 'task.json')
    let cn: string
    let tw: string
    try {
      cn = JSON.parse(readFileSync(simplified, 'utf8')).prompt
      tw = JSON.parse(readFileSync(traditional, 'utf8')).prompt
    } catch {
      continue
    }
    if (cn.length !== tw.length) continue
    for (let index = 0; index < cn.length; index += 1) {
      const from = tw[index] as string
      const to = cn[index] as string
      if (from !== to) pairs.set(from, to)
    }
  }
  assert.ok(pairs.size > 100, 'the fixture itself should carry a hundred-odd differences')

  // Word choice is not glyph shape. Every entry below is a *different word* in
  // the two locales, not a different shape of one: 資訊/信息, 揭露/披露,
  // 加快/加緊, 涵蓋/覆盖, 資料/数据, 盈餘/收益, 下市/摘牌. No character table
  // reaches those, and pretending otherwise by mapping 訊→信 would corrupt every other
  // use of the character. This list is the honest boundary of what folding buys,
  // and it grows as the benchmark grows — which is the intended signal.
  const lexical = new Set(['訊', '資', '揭', '快', '涵', '料', '盈', '餘', '下', '市'])
  for (const [from, to] of pairs) {
    if (lexical.has(from)) continue
    assert.equal(foldScript(from), foldScript(to), `unfolded glyph pair: ${from} / ${to}`)
  }
})

test('a traditional question reaches a simplified filing', () => {
  // MB-015 zh-TW, reduced. The filing states the instalment; the question asks
  // about it in traditional characters. Unfolded, the two share almost no
  // lexical units, so the passage never ranks, the gap review never sees it,
  // and the memo publishes 「沒有相應揭露，無法核實」 about a sentence that is
  // right there. The assertion is the one the pipeline actually makes: does the
  // passage get offered to the model at all?
  const filing = '本次交易首期支付交易对价的 60%，即人民币 11,400 万元。第二期支付剩余 40%。'
  const question = '本次交易的分期支付安排是什麼？首期支付對價的比例與金額分別是多少？'

  const candidates = candidatePassages([{ id: 'd', text: filing }], question, 3, { preferNumbers: true })
  assert.ok(candidates.length > 0, 'the gap review must be handed the passage that answers the question')
  assert.ok(candidates[0]?.text.includes('11,400'), 'and the figure must be in it')

  assert.ok(coverage('首期支付對價的比例與金額', filing) > 0.4)
  assert.ok(touchesTopic('分期支付對價', filing), 'checklist landing works across scripts too')
})

test('a quote retyped in the other script locates, and publishes the filing`s own characters', () => {
  const filing = '公司拟以现金方式支付交易对价的 60%，即人民币 11,400 万元。'
  const retyped = '支付交易對價的 60%，即人民幣 11,400 萬元'

  const located = locateQuote(filing, retyped)
  assert.ok(located, 'a real quote in the other script must still be found')
  assert.equal(located.quote, '支付交易对价的 60%，即人民币 11,400 万元')
  assert.equal(filing.slice(located.charStart, located.charEnd), located.quote)
  assert.equal(located.exact, false, 'and it is recorded as a non-exact match')
  // The published span is the document's, not the model's retyping.
  assert.equal(located.quote.includes('對'), false)
  assert.equal(located.quote.includes('幣'), false)
})

test('folding does not make unrelated passages locatable', () => {
  const filing = '公司计提各项减值准备共计 8,815.45 万元。'
  assert.equal(locateQuote(filing, '公司計提各項減值準備共計 9,999.99 萬元'), undefined)
  assert.equal(locateQuote(filing, '公司決定不再計提任何減值準備'), undefined)
})

test('a traditional unit declaration opens the same unit window', () => {
  const traditional = '單位：人民幣萬元\n資產減值損失 7,199.78 存貨跌價準備'
  const hints = detectUnitHints(traditional)
  assert.deepEqual(
    hints.map((hint) => [hint.unit, hint.multiplier]),
    [['CNY', '10000']],
  )
  // The declaration is reported as printed, in the document's own characters.
  assert.ok(hints[0]?.source.includes('單位') || hints[0]?.source.includes('单位'))
})

test('numbers keep the document`s glyphs in their raw token', () => {
  const tokens = extractNumbers('計提減值準備 8,815.45 萬元')
  const amount = tokens.find((token) => token.kind === 'amount')
  assert.ok(amount, 'a traditional amount must be recognized')
  assert.equal(amount.value, '88154500')
  assert.ok(amount.raw.includes('萬') || amount.raw.includes('万'))
})

test('a memo written in the wrong script is detectable', () => {
  // From a live MB-008 zh-TW run: 繁體 headings, and every finding underneath
  // them in 简体, because the filing was printed that way and the model kept
  // copying its character forms into its own sentences.
  const simplifiedBody =
    '本次定向增发目前处于董事会审议通过、预案已披露、尚需股东会审议、上交所审核及中国证监会同意注册的阶段。'
  const traditionalBody =
    '本次定向增發目前處於董事會審議通過、預案已揭露、尚需股東會審議、上交所審核及中國證監會同意註冊的階段。'

  assert.equal(matchesScript(simplifiedBody, 'zh-TW'), false)
  assert.equal(matchesScript(traditionalBody, 'zh-TW'), true)
  assert.equal(matchesScript(simplifiedBody, 'zh-CN'), true)
  assert.equal(matchesScript(traditionalBody, 'zh-CN'), false)

  // Characters shared by both scripts pick no side, so a short neutral sentence
  // is never accused of being in the wrong one.
  assert.equal(matchesScript('本次交易金额为 100 元。', 'zh-TW'), true)
  assert.deepEqual(scriptMix('ABC 123'), { traditional: 0, simplified: 0 })
})
