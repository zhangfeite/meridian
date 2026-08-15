# Meridian Bench baselines

## Bare DeepSeek

The client uses the public chat-completions protocol with temperature `0`; it
adds no verification pipeline, tools, or post-processing.

```bash
export DEEPSEEK_API_KEY='...'
uv run --project meridian/bench/runner bench run \
  --agent "python3 meridian/bench/baselines/deepseek_agent.py" \
  --protocol subprocess \
  --tasks all \
  --lang zh-CN,zh-TW,en \
  --timeout 180 \
  --retries 2 \
  --output meridian/bench/baselines/deepseek-full
```

`DEEPSEEK_BASE_URL`, `DEEPSEEK_MODEL`, and `DEEPSEEK_TIMEOUT` are optional. The
client is covered by a local fake-server test, so its wire format can be checked
without network access. A genuine score must only be checked in after all 60
ordinary tasks are present and an architect runs this command with API access.

## Offline template smoke baseline

```bash
uv run --project meridian/bench/runner bench run \
  --agent "python3 meridian/bench/baselines/template_agent.py" \
  --protocol subprocess \
  --tasks all \
  --lang zh-CN,zh-TW,en \
  --output meridian/bench/baselines/template-current
```

This deterministic script proves the offline subprocess path and report
generation. It is deliberately content-poor and is not a substitute for the
required full DeepSeek baseline.

The checked-in `template-current/` artifact covers the four ordinary zh-CN task
instances available on 2026-08-14 (MB-001 through MB-004): overall `0.625`,
number fidelity `1.000`, citation alignment `0.250`, compliance `1.000`, and
completeness `0.000`. Empty answers contain no wrong numbers, so numeric fidelity
is intentionally precision-like; completeness separately exposes the missing
facts.
