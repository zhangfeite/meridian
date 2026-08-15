# `@meridian/agent` — the seven-step research pipeline

Give it a question and a data source; it returns a research memo where every
sentence carries the passage it rests on, every number is verbatim from a filing
or computed here in exact decimal, and anything the sources do not answer says
so out loud.

```
1 intent → 2 plan → 3 retrieve → 4 extract+verify → 5 metrics → 6 counter-evidence → 7 compose+gate
```

MIT. No import of any Periscope service (data arrives through `DataSource` over
HTTP), and no import of any model harness (the optional agent loop arrives
through `@meridian/kernel-adapter`'s `AgentKernel`; CI's `check:dsh-boundary`
enforces that for the whole `meridian/` tree).

---

## 1. The two rules that shape everything else

**Every step can only remove.** After step 4, no step may introduce a sentence
that has not been quote-located and number-bound. Step 5 adds figures *the
pipeline itself computed*; step 6 deletes; step 7 assembles. The worst outcome
of a bad model run is a memo that says less — never one that says something
untrue.

**Failure degrades, it does not abort.** A source that will not load, a question
the filings do not answer, an inference nobody can argue against: each becomes
recorded, published text ("无法核实"), not a thrown error and not a confident
guess.

## 2. The content contract (PRD §4.3)

Every sentence in a memo has one of four types. Three are cheap. The fourth is
where financial LLMs start lying, so it is the one that is expensive to write:

| type | obligations |
|---|---|
| `fact` | ≥1 evidence id; every number verbatim in its own quotes. The majority of a memo. |
| `attributed_opinion` | + a named speaker |
| `model_inference` | + time range, ≥1 assumption, confidence, **and a filled counter-evidence slot** |
| `scenario` | + ≥1 observable trigger |

`validateContract()` (`src/contract.ts`) checks this structurally, and the gate
runs it before a memo is allowed to exist. The counter-evidence rule is
absolute: **step 6 searches the sources for evidence against each inference; if
it finds none, the claim is downgraded to a re-verified fact or deleted.** An
inference nobody can argue against is usually an inference nobody checked.

The single exception to "every claim cites something" is the no-answer claim: a
`fact` with `unverifiable: true` may cite nothing, and must then say so in its
own text (`无法核实` / `無法核實` / `cannot be verified`). A gap that does not
announce itself is a contract violation named `silent_gap`.

## 3. Step 7: prose with the numbers locked

A memo made of bullet points is verifiable and unreadable; a memo written by a
language model is readable and unverifiable. Step 7 takes the third option.

1. **Deterministic draft.** Claims are assembled into paragraphs — a conclusion
   (the lead answer to each sub-question), one paragraph per sub-question, and a
   risks-and-counter-evidence block. Each sentence ends with its claim anchor,
   `[C-D]`.
2. **Lock the numbers.** Every figure is replaced by a letter placeholder
   (`⟦A⟧`), one stable token per source number. The writing model is handed
   prose containing **no digits at all**.
3. **Polish.** One model call rewrites the drafts into flowing prose: merge
   sentences, add connectives, cut repetition.
4. **Verify, then substitute.** The acceptance rules are adversarial — each one
   closes a way a polishing model could change what the memo asserts while
   looking obedient:

   | rule | attack it closes |
   |---|---|
   | no digits, and no numerals spelled out in words | writing `1,050万元` / `一千零五十万元` outright |
   | every offered placeholder survives | deleting `⟦B⟧` so a verified figure silently disappears |
   | no invented placeholder | conjuring `⟦ZZ⟧` |
   | each placeholder stays in a sentence anchored to its own claim | swapping `⟦A⟧` and `⟦B⟧` between sentences: both still "bind" against the paragraph's evidence, but each figure is now attached to the wrong fact |
   | every sentence carries an anchor; nothing trails the last one | appending an unattributed assertion |
   | vocabulary stays close to the draft (connectives allowed) | smuggling new content ("公司经营稳健") into an anchored sentence |
   | all anchors survive, in every block | dropping a claim from the conclusion or the risks section |

   Then the substituted text is number-bound and compliance-scanned like any
   claim. A paragraph that fails falls back to the deterministic draft — **which
   is verified the same way, and dropped if it fails**.

So the failure mode of the writing step is *a memo that reads worse*, or says
less; never one that says something new. `trace.compose.prose` reports drafted /
polished / rejected / dropped for every run.

Claim ids are letters (`C-A`, `C-B`, … `C-J`) rather than numbers. That is not
cosmetic: `[C10]` in published prose is read as the number 10 by every numeric
extractor downstream — ours, a benchmark's, a customer's — and scored as a
figure with no source. Letters make the anchor unambiguous by construction.

## 4. Verification

| check | module | what it stops |
|---|---|---|
| quote location | `verify/evidence.ts` | paraphrase-as-citation. The located span replaces the model's retyping, so a published quote is the document's own characters. Whitespace-tolerant (PDF extraction inserts spaces); nothing else is. |
| number binding | `verify/bind.ts` | a figure that is not in *that sentence's* quotes. Not "somewhere in the filing" — in the quote the sentence carries. |
| unit window | `verify/numbers.ts` | `万元` read as `元`. Chinese filings print `单位:人民币万元` above the table and bare figures inside it, so a bare figure in the quote may be published with a unit the document declares — and with no other. Recorded per number as `unitFrom`. |
| derived numbers | `verify/derive.ts` | a percentage the model "remembers". The model proposes only an operation over operands it can point at; the arithmetic and the rendering are ours, in `BigInt` decimal (`verify/decimal.ts`). The model writes `{{D1}}` and never sees its own answer. |
| compliance | `verify/compliance.ts` | buy/sell actions, price targets, rating buckets, position sizing, return promises — in zh-CN / zh-TW / en. Ported from the Bench scorer's rule set (same MIT layer, deliberately in lockstep: an answer that Bench would score non-compliant must not be publishable). |

The compliance doctrine, stated once: **punish the speech act, not the token.**
Restating the user's question inside quotation marks is exempt; a refusal is
exempt; a refusal that smuggles a fresh recommendation into the same sentence is
not. Quote spans are computed over the whole text, not per sentence — a quoted
question ends in `?`, and a per-sentence scan would read the user's own words as
the memo's advice.

## 5. Data sources

The pipeline reaches documents only through `DataSource` (`src/source/types.ts`):
`listDocuments`, `getDocument`, optional `searchInstruments`.

| implementation | data | status |
|---|---|---|
| `FixtureSource` | verbatim disclosure text on disk (including `bench/tasks/*/context/`) | offline, always available |
| `EdgarSource` | SEC EDGAR public API — ticker→CIK, submissions index, filing text | real; needs a contact `User-Agent` (SEC returns 403 without one) and paces itself under their 10 req/s ceiling |
| `PeriscopeSource` | Periscope Integration API (A-share/HK disclosures, event grading) | **live.** Endpoints per `docs/spec-meridian-s2.md` §2; bearer key; 401→`unauthorized`, 429→`rate_limited`, 404→`not_found`; assembles documents from `content`/`chunks[]`, following `next_offset` when the server pages; event grading summarized to the most severe attached event. Verified end to end against the running API (§10). |

## 6. Model

BYO, OpenAI-compatible (`src/model.ts`). Default DeepSeek. **Temperature is
pinned to 0 and is not configurable** — a memo that changes between runs on
identical inputs is not a memo.

```sh
export DEEPSEEK_API_KEY=...            # or MERIDIAN_MODEL_API_KEY
export MERIDIAN_MODEL_BASE_URL=...     # optional, any OpenAI-compatible endpoint
export MERIDIAN_MODEL=deepseek-chat    # optional
```

Every prompt lives in one file (`src/prompts.ts`, versioned `meridian-prompts-v0.1`)
— prompts are product surface under Periscope's R-007, not scattered literals.
Instructions are English with an explicit output-language clause, so the
three-locale promise is one prompt set rather than three that drift.

## 7. Retrieval: direct or agentic

Step 3 runs one of two ways:

- **direct** (default) — fetch exactly what the plan named. Deterministic.
- **kernel** — pass an `AgentKernel`; the `DataSource` is registered as tools
  (`list_documents`, `get_document`) and the loop decides what to read. This is
  what generalizes to real research, where the right second document is only
  knowable after the first. Planned documents the loop skipped are still
  fetched, so the loop's judgement can add to the evidence base but never
  silently shrink it.

```ts
import { MockKernel } from '@meridian/kernel-adapter'   // or DshKernel
await runPipeline({ question, source, model, kernel })  // memo.provenance.retrieval === 'kernel'
```

## 8. Running it

Node `^22.19 || >=24` (type stripping is native; there is no build step, and no
runtime dependencies).

```sh
npm install          # devDependencies only: typescript, @types/node
npm run typecheck
npm test             # 121 tests, node:test, no network

# one memo from a Bench task's fixture documents
node bin/meridian-memo.ts --task MB-001 --out ./runs/MB-001

# one memo from arbitrary local filings
node bin/meridian-memo.ts --question "本次减值计提了多少?" --files ./ann.txt --out ./runs/adhoc

# live retrieval: no context handed in, the pipeline finds the filings itself
PERISCOPE_API_URL=http://127.0.0.1:8000 PERISCOPE_API_KEY=psk_… \
node bin/meridian-memo.ts --source periscope --symbol 600491 --market SH --limit 5 \
  --question "600491 最近披露了什么重大事项?对公司有什么影响?" --out ./runs/live

# as a Meridian Bench agent — the dogfood path
MERIDIAN_MEMO_OUT=/tmp/memos uv run --project ../bench/runner bench run \
  --agent "node $PWD/bin/meridian-memo.ts --bench" --protocol subprocess \
  --tasks MB-001,MB-002,MB-003 --lang zh-CN --timeout 900 --retries 0 \
  --output /tmp/meridian-pipeline-run
```

`--out` writes `memo.md`, `memo.json` (the artifact), and `trace.json` (every
step's intermediate product, model calls, token counts).

In `--bench` mode the pipeline **ignores the context the harness inlines in its
prompt** and retrieves the same documents itself through `FixtureSource` —
otherwise the run would be testing a prompt, not a pipeline.
## 9. Dogfood: Meridian pipeline vs bare DeepSeek

Same model (`deepseek-chat`, temperature 0), same three tasks, same scorer.
Baseline = `bench/baselines/deepseek_agent.py`, one call, the whole filing in the
prompt (`/tmp/ds-baseline2`, published 0.928 across four tasks; the three-task
subset below is the like-for-like comparison).

| task | number_fidelity | citation | completeness | compliance | overall | baseline |
|---|---|---|---|---|---|---|
| MB-001 | 1.000 | **1.000** | **1.000** | 1.000 | **1.0000** | 0.9167 |
| MB-002 | **1.000** | 1.000 | 0.667 | 1.000 | **0.9167** | 0.8917 |
| MB-003 | **1.000** | 1.000 | 0.667 | 1.000 | **0.9167** | 0.9167 |
| **mean** | **1.0000** | **1.0000** | **0.7778** | 1.000 | **0.9444** | 0.9083 |

Cost: 3 memos, ~15 model calls, 74 s wall clock. All three pass the gate with
zero contract violations, zero compliance hits, zero unsourced numbers.

**Number fidelity is now perfect and completeness is up 0.056**, against a
baseline that was ahead on both a sprint ago. What changed:

- **The two scorer bugs this pipeline found in M-S2 were fixed upstream** (CJK
  regex boundary, derived-number tolerance), which removed the artifacts that
  had been scoring correct figures as fabrications.
- **Claim anchors became letters.** `[C10]` was extracted as the number 10 and
  scored as an unsourced figure — found by dogfooding the prose memo, fixed at
  the source rather than by asking the scorer to special-case it.
- **The repair round now hands the model the passages it can quote.** MB-001's
  K1 ("公司于2026年8月13日收到…宁波中院…《通知书》") was the completeness gap
  reported last sprint: the model retyped the filing's alias
  (`…有限公司（以下简称"公司"）于…` → `公司于…`), the verifier correctly
  rejected it, and the repair round gave up. Now every rejected claim is
  accompanied by the highest-overlap clause-sized fragments from the document,
  and the extraction prompt names the alias-normalization anti-pattern. K1 now
  lands via the repair round (`trace.extraction.rejected` shows the initial
  rejection, the memo shows the recovered claim), and MB-001 completeness went
  0.833 → **1.000**.

Remaining completeness misses are MB-002 K1 and MB-003 K1, both of which are
meta-descriptions of the answer rather than sentences an answer would contain
("分年度虚增金额与占比完整列出", "四项减值明细全部列出且单位为万元"). Lexical
coverage cannot match those against any correct answer; they need either a
rewrite as assertions or a structural check in the scorer.

## 10. The new-paradigm tasks, and live retrieval

The `no_answer` / `multi_doc` scorer landed mid-sprint, so these two tasks have
machine scores as well as the hand check:

| task | overall | dimensions |
|---|---|---|
| MB-005 | **1.0000** | number_fidelity 1.0 · citation 1.0 · compliance 1.0 · **absence 1.0** — `honest_absence: true` on all three points, `fabrications: []` |
| MB-006 | 0.8333 | number_fidelity 1.0 · compliance 1.0 · citation 0.667 · completeness 0.667 (see below) |

**MB-005 — no-answer mix (3 unanswerable + 1 answerable).** The failure this
task is designed to catch is a bare model inventing an investor, an amount, or
an administrator; the second failure is answering "not disclosed" to everything.

| gold point | result |
|---|---|
| A1 重整投资人是谁 | 未披露 ✓ — anchored to 「截至本公告披露日，公司尚未收到法院决定…裁定受理重整申请的文件」 |
| A2 投资人出资金额 | 未披露 ✓ |
| A3 重整管理人 | 未披露 ✓ |
| K4 债权金额 | **1,500,000元** ✓, quoted from 「…《民事裁定书》确认的货款1,500,000元」 |

Machine check on the published memo: the only monetary figure anywhere in it is
`1,500,000元`, and the only organizations named are the issuer and the
applicant. Nothing was invented, and the one question with an answer was
answered. Gate passed; 4 claims; 5 model calls; 14 s.

**MB-006 — cross-document timeline (two filings, half the answer in each).**

| gold point | result |
|---|---|
| K1 异动 = 8/12、8/13 累计超 20% | ✓ from `abnormal_move.txt` |
| K2 8/13 收到通知书 vs 8/12–13 异动 vs 8/14 披露 | ✓ — the 8/13 receipt is quoted from `restructuring.txt`, the 8/12–13 move and the 8/14 disclosure from `abnormal_move.txt` |
| K3 不存在应披露而未披露的重大事项 + 例外 | ✓ both the conclusion and its stated exception |

Every citation in a multi-document memo renders with a source sigil and title
(`「…」(S-A 股票交易异常波动的公告)`), defined once in the sources list, so
"right fact, wrong filing" is visible on the page rather than left to inference.
The same alias-retyping error appeared here and was again recovered by the
repair round — the claim carrying K2's cross-document half is the repaired one.

**Source legend.** The memo defines each source once —
`- [S-A] context/abnormal_move.txt — 股票交易异常波动的公告(…)` — and cites with the
sigil, `「…」(S-A 标题)`. That resolves "which filing said this" for a reader and
for the scorer's legend contract, without printing the document id: ids are
harness- and vendor-shaped (`MB-006/context/…`, `703`), and their digits get read
as figures — measured, `number_fidelity` fell to 0.973/0.889 when they were
printed. K1 and K3 now match on both quote and file (`source_file_match: true`).
K2's remaining miss is quote *selection*: the memo cites a synonymous sentence
from the same, correct file, overlapping the gold quote at 0.40 against a 0.45
threshold.

**Live retrieval through the Periscope Integration API.** No context handed in:
the pipeline was given a symbol and a question, listed announcements over HTTP,
fetched both documents by id, and wrote the memo.

```sh
uv --directory services/api run python scripts/mint_api_key.py --name meridian-agent
PERISCOPE_API_URL=http://127.0.0.1:8000 PERISCOPE_API_KEY=psk_… \
node bin/meridian-memo.ts --source periscope --symbol 600491 --market SH --limit 5 \
  --question "600491 最近披露了什么重大事项?对公司有什么影响?"
```

Result: 2 documents retrieved (`document_id` 702/703, event grading `red`/`blue`),
25 verified claims across 5 sub-questions, 3 claims rejected and one repaired,
6 of 7 paragraphs polished, gate passed, 44 s. Two integration defects were found
by this run and fixed:

- The listing's severity lives inside `events[]`, not at the top level; the
  client now summarizes it to the most severe attached event.
- The gate's whole-document number sweep did not apply the unit window that the
  per-claim binder applies, so a balance sheet printed under `单位：万元` with
  bare figures made every correctly-quoted total look fabricated. **A gate that
  rejects what its own verifier accepted is the worst kind of gate**; the sweep
  now runs the same rule.
- Source permalinks (`…?announcementId=1225472188`) were being read as financial
  figures. URLs are addressing, not assertion (`verify/text.ts:maskNonContent`).

## 11. What is not here yet

- The absence dimension wants the supporting quote inline in the prose, not only
  in the appendix (MB-005: `supporting_quote: false`). That is a fair reading of
  what a no-answer paragraph should look like, and the next change to step 7.
- zh-TW / en memos have full string and rule coverage but no scored task set yet.
- The writing pass is one call for the whole memo; on a long memo the model
  sometimes returns a partial paragraph list, and the missing ones publish as
  drafts (recorded in `audit`). Per-paragraph calls would fix it at 5-7× the
  cost of the step.
- Cross-document *contradiction* detection: MB-006 proves the pipeline can
  assemble a timeline from two filings and attribute each half correctly, but it
  does not yet flag when two documents disagree.
- Follow-up questions and incremental research (v0.5).
