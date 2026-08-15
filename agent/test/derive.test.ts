/**
 * Derived numbers: the pipeline computes, the model only proposes.
 *
 * The interesting assertions are the refusals — an operand the model cannot
 * point at, and a mixed-unit sum, are exactly the two ways a plausible-looking
 * financial calculation goes wrong.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { EvidenceRef } from '../src/contract.ts'
import { computeDerivations, type DerivationProposal } from '../src/verify/derive.ts'
import { computeMetrics } from '../src/steps/metrics.ts'
import { ScriptedModel } from '../src/model.ts'
import { idAllocator } from '../src/ids.ts'
import { detectUnitHints } from '../src/verify/numbers.ts'

const table = '单位：人民币万元\n资产减值损失 7,199.78 存货跌价准备\n合计 8,815.45'
const declaredUnits = detectUnitHints(table)

const evidence: EvidenceRef[] = [
  {
    id: 'E1',
    documentId: 'D1',
    quote: '资产减值损失 7,199.78 存货跌价准备',
    charStart: 0,
    charEnd: 10,
    sourceLabel: 'D1',
    retrievedAt: '2026-08-14T00:00:00.000Z',
    declaredUnits,
  },
  {
    id: 'E2',
    documentId: 'D1',
    quote: '合计 8,815.45',
    charStart: 20,
    charEnd: 30,
    sourceLabel: 'D1',
    retrievedAt: '2026-08-14T00:00:00.000Z',
    declaredUnits,
  },
]

test('a ratio is computed exactly and rendered by the pipeline', () => {
  const { derived, rejected } = computeDerivations(
    [
      {
        id: 'D1',
        label: '存货跌价准备占减值合计比例',
        op: 'ratio',
        precision: 2,
        operands: [
          { display: '7,199.78 万元', evidenceId: 'E1' },
          { display: '8,815.45 万元', evidenceId: 'E2' },
        ],
      },
    ],
    evidence,
  )
  assert.deepEqual(rejected, [])
  assert.equal(derived[0]?.display, '81.67%')
  assert.equal(derived[0]?.formula, '7,199.78 万元 / 8,815.45 万元')
  assert.equal(derived[0]?.value, '0.8167229126')
})

test('an operand found in another quote of the same filing still counts', () => {
  // MB-012 lost two derivations this way: the figures were verbatim in a cited
  // quote, just not the one the model paired them with. The invariant is "every
  // operand is verbatim in a cited quote of this filing" — which quote is the
  // model's bookkeeping, and the recorded evidence id is corrected to the truth.
  const { derived, rejected } = computeDerivations(
    [
      {
        id: 'D1',
        label: '回购均价',
        op: 'ratio',
        precision: 4,
        operands: [
          // Both name E1; 8,815.45 actually lives in E2.
          { display: '7,199.78 万元', evidenceId: 'E1' },
          { display: '8,815.45 万元', evidenceId: 'E1' },
        ],
      },
    ],
    evidence,
  )
  assert.deepEqual(rejected, [])
  assert.equal(derived[0]?.inputs[1]?.evidenceId, 'E2', 'attribution follows the figure')
})

test('an operand is never satisfied from a different filing', () => {
  // The cross-company collision MB-012 is built around: 5,000,000 shares appears
  // in two different issuers' announcements. Widening the search to the whole
  // evidence pool would let one company's figure prove another's arithmetic.
  const crossFiling: EvidenceRef[] = [
    { ...evidence[0], id: 'E1', documentId: 'qinshang', quote: '本次减持回购股份数量为 5,000,000 股' },
    { ...evidence[1], id: 'E9', documentId: 'kuaiyi', quote: '本次解除质押 16,498,650 股' },
  ]
  const { derived, rejected } = computeDerivations(
    [
      {
        id: 'D1',
        label: '跨公司拼凑',
        op: 'ratio',
        operands: [
          { display: '5,000,000', evidenceId: 'E1' },
          { display: '16,498,650', evidenceId: 'E1' },
        ],
      },
    ],
    crossFiling,
  )
  assert.equal(derived.length, 0)
  assert.match(rejected[0]?.reason ?? '', /does not occur in any quote/)
})

test('an amount over a share count is a unit price, not a ratio or a multiple', () => {
  // The most common derivation in a buyback filing, and the one MB-012 asks for:
  // 30,050,162.75 元 ÷ 16,498,650 股 = 1.82 元/股. As a ratio it would print
  // "182%"; as a multiple, "1.82倍". Both are wrong about what the number is.
  const buyback: EvidenceRef[] = [
    { ...evidence[0], id: 'E1', declaredUnits: [], quote: '成交总金额为 30,050,162.75 元（不含交易费用）' },
    { ...evidence[1], id: 'E2', declaredUnits: [], quote: '累计回购公司股份 16,498,650 股' },
  ]
  const { derived, rejected } = computeDerivations(
    [
      {
        id: 'D1',
        label: '回购均价',
        op: 'quotient',
        precision: 2,
        // Bare operands, as the model writes them — the filing supplies the units.
        operands: [
          { display: '30,050,162.75', evidenceId: 'E1' },
          { display: '16,498,650', evidenceId: 'E2' },
        ],
      },
    ],
    buyback,
  )
  assert.deepEqual(rejected, [])
  assert.equal(derived[0]?.display, '1.82 元/股')
  assert.equal(derived[0]?.unit, 'CNY/unit')
})

test('an operand the model cannot point at is rejected', () => {
  const { derived, rejected } = computeDerivations(
    [
      {
        id: 'D1',
        label: '编造的比例',
        op: 'ratio',
        operands: [
          { display: '9,999.99 万元', evidenceId: 'E1' },
          { display: '8,815.45 万元', evidenceId: 'E2' },
        ],
      },
    ],
    evidence,
  )
  assert.equal(derived.length, 0)
  assert.match(rejected[0]?.reason ?? '', /does not occur in any quote/)
})

test('a percentage operand is a ratio, not the number 30', () => {
  // The bug this guards produced 89,231,436,720 shares from 2,974,381,224 × 30
  // and published it: arithmetically faithful to what it was handed, 100× wrong
  // in the world, and invisible to every check because the derivation registry
  // vouched for it.
  const shares: EvidenceRef[] = [
    { ...evidence[0], id: 'E1', quote: '上市公司总股本为 2,974,381,224 股' },
    { ...evidence[1], id: 'E2', quote: '发行的股票数量不超过发行前总股本的 30%' },
  ]
  const { derived, rejected } = computeDerivations(
    [
      {
        id: 'D1',
        label: '发行数量上限',
        op: 'product',
        precision: 0,
        operands: [
          { display: '2,974,381,224', evidenceId: 'E1' },
          { display: '30%', evidenceId: 'E2' },
        ],
      },
    ],
    shares,
  )
  assert.deepEqual(rejected, [])
  assert.equal(derived[0]?.display, '892314367')
  assert.equal(derived[0]?.unit, 'scalar')

  // Two proportions multiplied is a proportion — 30% of 30% is 9%, and the
  // dimensional algebra says so rather than rendering it as "0.09 times".
  const compounded = computeDerivations(
    [
      {
        id: 'D2',
        label: '复合比例',
        op: 'product',
        precision: 2,
        operands: [
          { display: '30%', evidenceId: 'E2' },
          { display: '30%', evidenceId: 'E2' },
        ],
      },
    ],
    shares,
  )
  assert.equal(compounded.derived[0]?.unit, 'ratio')
  assert.equal(compounded.derived[0]?.display, '9.00%')
})

test('mixed units cannot be summed, and one operand is not a calculation', () => {
  const mixed = computeDerivations(
    [
      {
        id: 'D1',
        label: '混合单位求和',
        op: 'sum',
        operands: [
          { display: '7,199.78 万元', evidenceId: 'E1' },
          { display: '8,815.45 元', evidenceId: 'E2' },
        ],
      },
    ],
    evidence,
  )
  assert.equal(mixed.derived.length, 0)

  const lonely = computeDerivations(
    [{ id: 'D2', label: '单操作数', op: 'sum', operands: [{ display: '7,199.78 万元', evidenceId: 'E1' }] }],
    evidence,
  )
  assert.match(lonely.rejected[0]?.reason ?? '', /at least two operands/)
})

test('a sum in a declared unit keeps that unit', () => {
  const { derived } = computeDerivations(
    [
      {
        id: 'D1',
        label: '两项合计',
        op: 'sum',
        precision: 2,
        operands: [
          { display: '7,199.78 万元', evidenceId: 'E1' },
          { display: '8,815.45 万元', evidenceId: 'E2' },
        ],
      },
    ],
    evidence,
  )
  // 7199.78万 + 8815.45万 = 16015.23万 = 160,152,300 元
  assert.equal(derived[0]?.value, '160152300')
  assert.equal(derived[0]?.unit, 'CNY')
})

// --- derivation chains -------------------------------------------------------

/** Buyback figures: an amount, a share count, and a per-share sale price. */
const buyback: EvidenceRef[] = [
  { ...evidence[0], id: 'E1', declaredUnits: [], quote: '成交总金额为 30,050,162.75 元（不含交易费用）' },
  { ...evidence[1], id: 'E2', declaredUnits: [], quote: '累计回购公司股份 16,498,650 股' },
  { ...evidence[0], id: 'E3', declaredUnits: [], quote: '本次减持均价为 3.62 元/股' },
]

/** The MB-012 shape: average buyback price, then the premium over it. */
const chain: DerivationProposal[] = [
  {
    id: 'D1',
    label: '回购均价',
    op: 'quotient',
    precision: 2,
    operands: [
      { display: '30,050,162.75', evidenceId: 'E1' },
      { display: '16,498,650', evidenceId: 'E2' },
    ],
  },
  {
    id: 'D2',
    label: '减持均价相对回购均价的倍数',
    op: 'quotient',
    precision: 2,
    operands: [{ display: '3.62 元/股', evidenceId: 'E3' }, { derivedId: 'D1' }],
  },
]

test('a derivation can consume another derivation', () => {
  const { derived, rejected, byProposal } = computeDerivations(chain, buyback)
  assert.deepEqual(rejected, [])
  assert.equal(byProposal.get('D1')?.display, '1.82 元/股')
  // 3.62 ÷ 1.8214… = 1.9875… → the premium MB-012 asks for.
  assert.equal(byProposal.get('D2')?.display, '1.99倍')
  assert.equal(byProposal.get('D2')?.depth, 2)
  assert.deepEqual(byProposal.get('D2')?.dependsOn, [byProposal.get('D1')?.id])
  // The chain is hand-checkable: the second link names the first.
  assert.match(byProposal.get('D2')?.formula ?? '', /\[[A-Z]-[A-Z]+\] 1\.82 元\/股/)
  assert.equal(derived.length, 2)
})

test('order of proposals does not matter — dependencies evaluate first', () => {
  const reversed = [chain[1] as DerivationProposal, chain[0] as DerivationProposal]
  const { rejected, byProposal } = computeDerivations(reversed, buyback)
  assert.deepEqual(rejected, [])
  assert.equal(byProposal.get('D2')?.display, '1.99倍')
})

test('a circular chain is rejected, not evaluated', () => {
  const { derived, rejected } = computeDerivations(
    [
      { id: 'D1', label: '甲', op: 'quotient', operands: [{ display: '3.62 元/股', evidenceId: 'E3' }, { derivedId: 'D2' }] },
      { id: 'D2', label: '乙', op: 'quotient', operands: [{ display: '3.62 元/股', evidenceId: 'E3' }, { derivedId: 'D1' }] },
    ],
    buyback,
  )
  assert.equal(derived.length, 0)
  assert.equal(rejected.length, 2)
  for (const item of rejected) assert.match(item.reason, /cycle/)
})

test('a chain deeper than the limit is rejected', () => {
  const link = (id: string, upstream: string): DerivationProposal => ({
    id,
    label: id,
    op: 'quotient',
    operands: [{ display: '3.62 元/股', evidenceId: 'E3' }, { derivedId: upstream }],
  })
  const { derived, rejected } = computeDerivations(
    [chain[0] as DerivationProposal, link('D2', 'D1'), link('D3', 'D2'), link('D4', 'D3')],
    buyback,
  )
  // D1..D3 are depth 1..3; D4 would be depth 4.
  assert.equal(derived.length, 3)
  assert.equal(rejected.length, 1)
  assert.match(rejected[0]?.reason ?? '', /4 deep, over the limit of 3/)
})

test('units propagate along the chain', () => {
  const { byProposal } = computeDerivations(chain, buyback)
  // 元 ÷ 股 = a unit price; 元/股 ÷ 元/股 = a dimensionless multiple.
  assert.equal(byProposal.get('D1')?.unit, 'CNY/unit')
  assert.equal(byProposal.get('D2')?.unit, 'multiple')

  // A percentage times an amount stays in the amount's unit, chained or not.
  const percent = computeDerivations(
    [
      {
        id: 'P1',
        label: '三成金额',
        op: 'product',
        precision: 2,
        operands: [
          { display: '30,050,162.75', evidenceId: 'E1' },
          { display: '30%', evidenceId: 'E4' },
        ],
      },
    ],
    [...buyback, { ...evidence[0], id: 'E4', declaredUnits: [], quote: '不超过发行前总股本的 30%' }],
  )
  assert.equal(percent.derived[0]?.unit, 'CNY')
  assert.equal(percent.derived[0]?.display, '9015048.83')
})

test('tolerance propagates: dividing rounded figures compounds their rounding', () => {
  const { byProposal } = computeDerivations(chain, buyback)
  const first = Number(byProposal.get('D1')?.tolerance)
  const second = Number(byProposal.get('D2')?.tolerance)
  // 3.62 is printed to two places, so it alone carries ~0.005/3.62 ≈ 0.14%.
  // The chain adds that to whatever D1 already carried — never less.
  assert.ok(first > 0 && first < 0.001, `leaf tolerance: ${first}`)
  assert.ok(second > first, 'a chained result is at least as uncertain as its input')
  assert.ok(second > 0.001 && second < 0.01, `chained tolerance: ${second}`)

  // Sums add absolute error, so a total of like-sized figures stays as precise.
  const summed = computeDerivations(
    [
      {
        id: 'S1',
        label: '合计',
        op: 'sum',
        precision: 2,
        operands: [
          { display: '879.50 万元', evidenceId: 'E5' },
          { display: '120.50 万元', evidenceId: 'E6' },
        ],
      },
    ],
    [
      { ...evidence[0], id: 'E5', declaredUnits: [], quote: '计提存货跌价准备 879.50 万元' },
      { ...evidence[0], id: 'E6', declaredUnits: [], quote: '计提应收账款坏账准备 120.50 万元' },
    ],
  )
  assert.equal(summed.derived[0]?.display, '10000000.00')
  // ±0.005 万元 on each figure is ±50 元 twice: ±100 元 on 10,000,000 = 1e-5.
  // Addition propagates *absolute* error, so the total is relatively more
  // precise than its smaller term — treating it multiplicatively would have
  // added 5.7e-6 + 4.2e-5 and overstated the uncertainty fourfold.
  const total = Number(summed.derived[0]?.tolerance)
  assert.ok(Math.abs(total - 0.00001) < 1e-9, `sum tolerance: ${total}`)
  assert.ok(total < 5.7e-6 + 4.2e-5)
})

// --- dimensions and intervals ------------------------------------------------

test('a quotient with no representable dimension is rejected, not renamed', () => {
  // 元 ÷ 元/股 is a share count. Before the dimensional algebra it fell through
  // to the default branch and published as 「倍」 — arithmetically right, and a
  // wrong statement about the world.
  const priced: EvidenceRef[] = [
    { ...evidence[0], id: 'E1', declaredUnits: [], quote: '成交总额为 18,111,062 元' },
    { ...evidence[1], id: 'E2', declaredUnits: [], quote: '均价为 3.62 元/股' },
  ]
  const shares = computeDerivations(
    [
      {
        id: 'D1',
        label: '成交股数',
        op: 'quotient',
        precision: 0,
        operands: [
          { display: '18,111,062 元', evidenceId: 'E1' },
          { display: '3.62 元/股', evidenceId: 'E2' },
        ],
      },
    ],
    priced,
  )
  assert.deepEqual(shares.rejected, [])
  assert.equal(shares.derived[0]?.unit, 'scalar', 'money ÷ money-per-share is a count')
  assert.equal(shares.derived[0]?.display, '5003056')

  // A count divided by money has no unit anyone can print.
  const inverted = computeDerivations(
    [
      {
        id: 'D2',
        label: '每元股数',
        op: 'quotient',
        operands: [
          { display: '3.62 元/股', evidenceId: 'E2' },
          { display: '18,111,062 元', evidenceId: 'E1' },
        ],
      },
    ],
    priced,
  )
  assert.equal(inverted.derived.length, 0)
  assert.match(inverted.rejected[0]?.reason ?? '', /no representable dimension/)

  // Two currencies never combine.
  const mixed = computeDerivations(
    [
      {
        id: 'D3',
        label: '跨币种',
        op: 'quotient',
        operands: [
          { display: '18,111,062 元', evidenceId: 'E1' },
          { display: '100 美元', evidenceId: 'E3' },
        ],
      },
    ],
    [...priced, { ...evidence[0], id: 'E3', declaredUnits: [], quote: '折合 100 美元' }],
  )
  assert.equal(mixed.derived.length, 0)
  assert.match(mixed.rejected[0]?.reason ?? '', /cannot divide/)
})

test('division propagates an interval, not a sum of relative errors', () => {
  // Two figures printed as `1` are each ±0.5, so 1÷1 is genuinely anywhere in
  // [0.33, 3]. Adding relative errors claims ±100%; the true half-width is 200%.
  const coarse: EvidenceRef[] = [
    { ...evidence[0], id: 'E1', declaredUnits: [], quote: '甲项为 1 股' },
    { ...evidence[1], id: 'E2', declaredUnits: [], quote: '乙项为 1 股' },
  ]
  const { derived } = computeDerivations(
    [
      {
        id: 'D1',
        label: '粗精度比值',
        op: 'quotient',
        precision: 2,
        operands: [
          { display: '1', evidenceId: 'E1' },
          { display: '1', evidenceId: 'E2' },
        ],
      },
    ],
    coarse,
  )
  const record = derived[0]
  assert.ok(record)
  assert.equal(record.value, '1')
  // 1.5/0.5 = 3 is the far endpoint: half-width 2, i.e. 200% relative.
  assert.equal(record.uncertainty, '2')
  assert.equal(Number(record.tolerance), 2)
  assert.ok(Number(record.tolerance) > 1, 'the naive relative-sum bound (1.0) understates this')
})

test('a divisor that might be zero is rejected, not divided by', () => {
  // `0.00` is not zero — it is [-0.005, 0.005]. Treating it as exact would let a
  // derivation divide by something that might be zero and call the answer certain.
  const zeroish: EvidenceRef[] = [
    { ...evidence[0], id: 'E1', declaredUnits: [], quote: '本期计提 1,000.00 万元' },
    { ...evidence[1], id: 'E2', declaredUnits: [], quote: '上期计提 0.00 万元' },
  ]
  const { derived, rejected } = computeDerivations(
    [
      {
        id: 'D1',
        label: '同比倍数',
        op: 'quotient',
        operands: [
          { display: '1,000.00 万元', evidenceId: 'E1' },
          { display: '0.00 万元', evidenceId: 'E2' },
        ],
      },
    ],
    zeroish,
  )
  assert.equal(derived.length, 0)
  assert.match(rejected[0]?.reason ?? '', /spans zero/)

  // The same zero is a perfectly good addend, and it carries its ±0.005 万元.
  const summed = computeDerivations(
    [
      {
        id: 'D2',
        label: '两期合计',
        op: 'sum',
        precision: 2,
        operands: [
          { display: '1,000.00 万元', evidenceId: 'E1' },
          { display: '0.00 万元', evidenceId: 'E2' },
        ],
      },
    ],
    zeroish,
  )
  assert.equal(summed.derived[0]?.display, '10000000.00')
  // ±50 元 from each figure: 100 元 on a 10,000,000 元 total.
  assert.equal(summed.derived[0]?.uncertainty, '100')
})

test('a unit the model repeats after the placeholder is absorbed, not printed twice', async () => {
  // Found by the M6 checklist audit on a live MB-012 run: the memo published
  // 「回购均价为1.82 元/股元/股」. The rendering carries its own unit, and a model
  // writing `{{D1}} 元/股` is writing ordinary prose — the pipeline, not the
  // model, has to reconcile the two.
  const buyback: EvidenceRef[] = [
    { ...evidence[0], id: 'E1', declaredUnits: [], quote: '成交总金额为 30,050,162.75 元（含交易费用）' },
    { ...evidence[1], id: 'E2', declaredUnits: [], quote: '累计回购公司股份 16,498,650 股' },
  ]
  const model = new ScriptedModel([
    JSON.stringify({
      derivations: [
        {
          id: 'D1',
          label: '回购均价',
          op: 'quotient',
          precision: 2,
          operands: [
            { display: '30,050,162.75', evidence_id: 'E1' },
            { display: '16,498,650', evidence_id: 'E2' },
          ],
        },
      ],
      claims: [
        {
          question_id: 'Q1',
          text: '按已披露数字计算,回购均价为{{D1}} 元/股。',
          derivation_ids: ['D1'],
          evidence_ids: ['E1', 'E2'],
        },
      ],
    }),
  ])

  const result = await computeMetrics(
    { entity: { name: '测试' }, questionType: 'metric_calc', seeksAdvice: false, subQuestions: [], lang: 'zh-CN' },
    buyback,
    model,
    'zh-CN',
    idAllocator('C'),
  )

  assert.deepEqual(result.rejected, [])
  assert.equal(result.claims[0]?.text, '按已披露数字计算,回购均价为1.82 元/股。')
  assert.equal(/元\/股\s*元\/股/.test(result.claims[0]?.text ?? ''), false)
})
