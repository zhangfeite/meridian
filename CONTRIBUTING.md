# Contributing to Meridian

Meridian's value is trust discipline. Every contribution is judged against one question: **does this make it harder or easier for an unverified number, quote, or recommendation to reach a reader?**

## Ground rules

1. **Analysis is not advice.** No code path may emit buy/sell actions, price targets, rating tiers, or return promises — in any language, in any format. The compliance gate is an architectural component; PRs that bypass it (even "temporarily") are rejected.
2. **Numbers are locked.** Model-facing prose passes never see digits (placeholder locking). Any change to `agent/src/prose.ts` or `agent/src/verify/` must keep the adversarial regression suite green and add tests for any new bypass surface you touch.
3. **The scorer is on trial too.** Meridian Bench trap tasks (`bench/tasks/MB-T*`) exist to test the judge, not the agent. Any scorer change must:
   - keep every trap failing (a scorer that rates planted errors highly is broken);
   - come with **both** a positive test (good output scores well) and a negative test (the specific bad output it exists to catch scores badly).
4. **Gold standards are hand-authored from real filings.** `key_points[].point` states an assertion about the world, never a meta-description of the expected answer ("all four items listed", "question 4 must be answered") — meta-text can never be lexically covered by a correct answer and has twice caused false score losses; authoring intent goes in `notes`. See `bench/tasks/SCHEMA.md` for the format. `verbatim` / `source_quote` / `evidence_quote` fields must be byte-exact substrings of the context files (CI checks this). Language variants (`task.zh-TW.json`, `task.en.json`) keep those fields identical to the base — citations always anchor to the source language.
5. **Honest benchmarks over marketing benchmarks.** If your change improves a score, the PR description must say why the *old* score was wrong (scorer defect, gold defect) or what capability actually improved. Score-chasing patches that special-case benchmark tasks are rejected.
6. **Kernel boundary.** Only allowlisted files may import `@deepseek-ai/*` (checked by `adapter/scripts/check-dsh-boundary.mjs` in CI). Financial logic goes through the `AgentKernel` interface.

## Dev loop

```bash
# Bench (Python, zero runtime deps)
uv --directory bench/runner run pytest -q
uv --directory bench/runner run bench validate

# Agent (TypeScript)
cd agent && npm test && npx tsc -p tsconfig.json --noEmit

# Kernel boundary
node adapter/scripts/check-dsh-boundary.mjs
```

## Adding a bench task

1. Pick a real, public filing. Author `task.json` + `gold.json` by hand against the primary source.
2. Run the quote checker (every `source_quote`/`evidence_quote` must be a substring of a context file, and for multi-doc tasks must exist **only** in its declared file).
3. `bench validate` must pass, including trap sensitivity.
4. State in the PR what failure mode the task is designed to expose (fabrication under absence, source confusion, unit traps, procedural-direction errors…). Tasks that a bare model already aces contribute little — see the task-design lessons in `bench/tasks/SCHEMA.md`.
