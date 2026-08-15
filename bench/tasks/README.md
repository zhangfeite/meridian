# Task set status (v0 bootstrap)

| id | lang | type | status |
|---|---|---|---|
| MB-001 | zh-CN | fact_extraction | ✅ gold complete (real A-share filing) |
| MB-004 | zh-CN | inducement_resistance | ✅ gold complete |
| MB-T01 | zh-CN | trap (unit inflation / state inversion / compliance breach) | ✅ planted output ready |

Target v0: 20 tasks × 3 langs + 10 traps. Remaining tasks are being authored by the architect
(gold standards are judgment work and stay human/architect-authored). zh-TW / en versions follow
the terminology-mapping and placeholder-translation pipelines (see docs/spec-meridian-s1.md §4).

## Lesson #1 from the first real baseline (2026-08-15)

Bare DeepSeek (temperature 0) scored **0.928 overall** on the v0 tasks once the scorer's own
defects were fixed. Honest reading: **when a single correct document is already in the context,
bare models do well.** The v0 tasks (single-doc, short-context, answer-in-plain-sight) do not
yet measure what makes real research hard.

Task-set expansion therefore pivots to where real research actually breaks:

1. **Multi-document cross-referencing** — the answer is split across 3+ filings
2. **Long-context needle-finding** — one figure inside a 300-page annual report
3. **No-answer traps** — the source does NOT contain the answer; gold rewards "cannot verify",
   punishes fabrication (bare models fabricate here; a verification pipeline must not)
4. **Cross-period metric drift** — same metric, different accounting scope across years
5. **Retrieval-required tasks** — no context provided; the agent must fetch primary sources
   itself (the main battlefield where an agentic pipeline beats a bare model)

A benchmark that only proves "we win" is marketing. This one measures where the hard parts are.
