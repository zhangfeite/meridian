# Meridian Bench runner

Meridian Bench is an MIT-licensed, deterministic benchmark for any financial
agent. It scores five behaviors: numeric fidelity, claim-to-citation alignment,
counter-evidence, compliance, and required-fact completeness. The runner is a
standalone Python package and has no dependency on Periscope services.

`no_answer` tasks additionally score every `absence_points[]` item. A truthful
non-disclosure answer with source support receives full absence credit, while a
made-up institution, person, or amount that is absent from both gold and source
forces the whole-task score to zero. This type-specific result is recorded at
`details.absence` and is combined with the task's ordinary numeric/citation
dimensions, so mixed tasks still require their answerable parts.

For `multi_doc` tasks, every citation must carry the exact `source_file` named
by `claim_evidence[]`. A quote with correct text but the wrong file does not
align; diagnostics expose this as `quote_match_wrong_source`.

## Install and validate

Python 3.9+ and [`uv`](https://docs.astral.sh/uv/) are supported.

```bash
uv sync --project meridian/bench/runner
uv run --project meridian/bench/runner bench validate
```

`validate` checks every available `task.json`/`gold.json`, resolves trap gold,
and scores every `planted.json` against its declared `expected` limits. A trap
that scores above a limit makes the command fail, so the same command is suitable
for CI.

## Test your agent

### HTTP protocol

```bash
uv run --project meridian/bench/runner bench run \
  --agent http://127.0.0.1:8080/answer \
  --tasks all \
  --lang zh-CN,zh-TW,en \
  --output ./my-meridian-run
```

The runner sends one `POST` per task:

```json
{
  "prompt": "task, source context, and answer instructions",
  "task_id": "MB-001",
  "lang": "zh-CN",
  "type": "fact_extraction"
}
```

The endpoint may return plain UTF-8 text or JSON with an `output`, `text`, or
`response` string. OpenAI-compatible `choices[0].message.content` is accepted as
well.

### Local subprocess protocol (offline)

```bash
uv run --project meridian/bench/runner bench run \
  --agent "python3 ./my_agent.py" \
  --protocol subprocess \
  --tasks MB-001,MB-004 \
  --lang zh-CN \
  --output ./my-local-run
```

The command receives the same JSON object on stdin and must print plain text or
the accepted JSON response shape to stdout. A new process is started for each
task. Relative command paths are resolved from the directory where `bench` was
invoked. Both adapters support `--timeout` and `--retries`.

`bench run` stores raw responses, scores them, and writes `report.json` plus
`report.md`. Planted `MB-Txx` judge tests are excluded from `--tasks all`; select
one explicitly only when debugging the scorer.

An adapter error or empty response marks that task `failed`, assigns zero to
all of its applicable dimensions, and makes the CLI exit with status 2 after
writing the manifest, scores, and report. Reports list the failed count and
per-task reasons.

## Offline rescoring and reporting

```bash
uv run --project meridian/bench/runner bench score ./my-meridian-run
uv run --project meridian/bench/runner bench report ./my-meridian-run
```

Scores are pure functions of task, gold, and output. Repeating `score` for an
unchanged run produces identical `scores.json`. Reports include the aggregate
for each dimension and a dimension-by-language matrix; `null`/`—` means that no
selected task scored that dimension or language.

## Run tests

```bash
uv run --project meridian/bench/runner --with pytest pytest
```
