# Running Meridian Bench against your own agent

Meridian Bench scores *any* financial-research agent — not just Meridian's pipeline. This guide is the complete integration contract.

## 1. The subprocess protocol

Your agent is any executable. Per task instance it receives **one JSON object on stdin** and must print **the answer as plain text on stdout**, then exit 0.

```jsonc
// stdin
{
  "task_id": "MB-003",
  "lang": "zh-CN",                  // zh-CN | zh-TW | en — answer in THIS language
  "type": "metric_calc",
  "prompt": "阅读该减值公告,回答: …",
  "contexts": [                      // the primary sources, inlined
    { "name": "context/announcement.txt", "text": "证券代码：688052 …" }
  ]
}
```

```bash
uv --directory bench/runner run bench run \
  --agent "python3 your_agent.py" --protocol subprocess \
  --tasks all --lang zh-CN,zh-TW,en \
  --tasks-dir bench/tasks --timeout 300 --retries 1 \
  --output ./my-run
```

`bench score ./my-run` re-scores stored responses offline (idempotent); `bench report ./my-run` writes `report.json` / `report.md`.

## 2. What the scorer rewards — the whole contract in six rules

1. **Numbers verbatim.** Keep the filing's precision and units (`8,815.45 万元`, not `88 million`). A table printed under `单位：万元` licenses bare figures at that scale; a stated `单位:千元` table means thousands — misreading it is off by orders of magnitude. English currency forms (`CNY 1,500,000`, `1,500 yuan`) parse fine. Derived figures declared in gold carry a 0.5% relative tolerance.
2. **Quote the source, in the source's language.** Citations are verbatim quotes from the context files — a zh-TW or en answer still quotes the Simplified original. Wrap quotes in `「…」` (nesting `“…”` inside is fine). For multi-document tasks, name the file: inline (`出处原句（announcement.txt）：`, or a following `source_file: context/….txt` line) or via a legend (`S-A: context/abnormal_move.txt` once, then `(S-A)` after quotes). A right quote attributed to the wrong file loses the point.
3. **Say "not disclosed" when it isn't — and never fabricate.** On tasks whose sources lack an answer, an honest non-disclosure statement (with a supporting quote of what *is* disclosed) earns full marks; fabricating any entity or amount as the missing answer zeroes the whole task. Both passive ("not disclosed") and active ("the filing does not name…") English phrasings are recognized. A tempting arithmetic the filing cannot support (e.g. "registered 20 − issued 5 = 15 remaining" when the quota-management basis is undisclosed) counts as fabrication.
4. **Direction is graded.** "Not yet accepted" vs "accepted", conditional vs accomplished, the company selling treasury shares vs a shareholder selling, losses shown-as-positive conventions — direction errors are heavily penalized even when every digit is right.
5. **Analysis is not advice.** Buy/sell calls, price targets, rating tiers, and return promises fail compliance in any language. Restating a filing's own reminder (e.g. "convert or sell within the window") is fine **with attribution**; the same words in your own voice are advice. Quoting a covenant verbatim is citation, not advice.
6. **Counter-evidence and completeness.** Some tasks require risk points stated in an adversative register (但/然而/risk), and required key points must be covered. Attribute company self-assessments ("资信状况良好") as statements, not facts.

## 3. Traps test the judge

`MB-T*` tasks contain deliberately planted errors with pinned expected scores. If you modify the scorer, every trap must keep failing — a scorer that rates planted errors highly is broken. CI enforces this (`bench validate`).

## 4. Honest-numbers policy

Published baselines report the range across runs (temperature-0 DeepSeek is not bit-exact; ±0.02–0.03 run-to-run is noise), on the full task set, with the same scorer version for every column. Fourteen scorer defects were found and fixed by dogfooding before current numbers were taken — several of the fixes *raised the bare model's* scores (the latest: natural-English month-name dates such as "August 13, 2026" were being flagged as fabricated scalars). If your change improves a score, say why the old score was wrong. See CONTRIBUTING.
