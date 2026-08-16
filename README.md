# Meridian 子午

> An open-source, self-hostable financial research agent that pulls primary sources, verifies every number verbatim, and writes memos where every claim traces back to the original filing — with China A-share & HK markets as first-class citizens.

**Status: v0.1 — early but real.** Three entry points (CLI · local Web UI · benchmark harness), five official skills, and an honest benchmark. Expect sharp edges; the trust discipline is the part we consider stable.

## What lives here

- **`bench/`** — Meridian Bench: an open benchmark that scores *any* financial agent on the five things that matter most: number fidelity, citation alignment, counter-evidence, compliance, and completeness. Includes trap tasks with deliberately planted errors to validate the scorer itself.
- **`agent/`** — the seven-step research pipeline (intent → plan → retrieve → extract+verify → metrics → counter-evidence → compose+gate). Every number a model writes is placeholder-locked: the prose-polishing pass literally never sees a digit. Claims the verifier rejects do not ship.
- **`adapter/`** — kernel-adapter: a thin abstraction over the agent kernel (currently [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness), version-pinned). Financial logic never touches kernel internals.
- **`skills/`** — official analysis skills (financial statements, event interpretation, valuation percentile — never price targets).
- Languages: English · 简体中文 · 繁體中文

## Quick start

```bash
# Score any agent (subprocess protocol: task JSON on stdin, answer on stdout)
uv --directory bench/runner run bench run \
  --agent "python3 your_agent.py" --protocol subprocess \
  --tasks all --lang zh-CN --output ./my-run

# Run the Meridian pipeline against the bench (BYO model; DeepSeek by default)
export DEEPSEEK_API_KEY=...
uv --directory bench/runner run bench run \
  --agent "node agent/bin/meridian-memo.ts --bench" --protocol subprocess \
  --tasks MB-001 --lang zh-CN --output ./meridian-run
```

25 hand-authored tasks from real Chinese filings × 3 languages (zh-CN / zh-TW / en) = 77 scored instances, plus scorer-validation traps. Task format and scoring contract: [`bench/tasks/SCHEMA.md`](bench/tasks/SCHEMA.md).

## Honest numbers (2026-08, deepseek-chat, temperature 0, full 25-task set, same scorer version)

| language | bare DeepSeek | Meridian pipeline | Δ |
|---|---|---|---|
| zh-CN | 0.8467 | **0.9837** | +0.137 |
| zh-TW | 0.8408 | **0.9812** | +0.140 |
| en | 0.5358 | **0.9600** | +0.424 |

75 instances per column, zero failed runs. The pipeline recorded **zero fabrication hard-failures**; the bare model fabricated on 4 instances — including writing "20亿 − 5亿 = **15亿** remaining" in all three languages on a task whose filing never discloses the quota-management basis (the tempting-but-unfounded-arithmetic trap working exactly as designed). Run-to-run variance is ±0.02–0.03; treat smaller differences as noise. Fourteen scorer defects were found and fixed during dogfooding before these numbers were taken — several fixes raised the *bare model's* scores (see CONTRIBUTING's honest-benchmark rule; the latest acquitted natural-English dates like "August 13, 2026", which had been flagged as fabricated scalars). Integration guide for third-party agents: [`bench/RUNNING.md`](bench/RUNNING.md).

Where the pipeline structurally differs from a bare model: it refuses to fabricate under absence (planted-fabrication traps score 0 by design), states residual non-disclosure even after answering the rule ("capped at X" answers the cap, not the value), attaches counter-evidence to inferences, placeholder-locks every number in prose (the writing model never sees a digit), carries interval uncertainty on derivation chains, and holds the memo language contract across scripts. The bare model remains genuinely strong at Simplified-Chinese extraction; we say so.

## 简体中文

开源、可自托管、BYO-model 的金融分析 Agent——自主拉取原始数据、逐字验证数字、产出每句话都可回溯到原始文件的研究备忘录。A股/港股是一等公民。分析不是建议:我们永不输出买卖动作、目标价、评级档位或收益承诺。

## 繁體中文

開源、可自託管、BYO-model 的金融分析 Agent——自主拉取原始資料、逐字驗證數字、產出每句話都可回溯到原始文件的研究備忘錄。A股/港股是一等公民。分析不是建議:我們永不輸出買賣動作、目標價、評級檔位或收益承諾。

## License

MIT. The trust backend (licensed market data, compliance gate execution, point-in-time store, audit service) is a separate commercial service and is not part of this repository.
