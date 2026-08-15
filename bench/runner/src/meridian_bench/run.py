"""Run orchestration and offline rescoring."""

import json
import os
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Sequence

from .adapters import AdapterError, AgentAdapter
from .scoring import score_task
from .tasks import LoadedTask, load_tasks


RUN_SCHEMA_VERSION = "meridian-bench-run-v1"


def write_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as handle:
        json.dump(value, handle, ensure_ascii=False, indent=2, sort_keys=True)
        handle.write("\n")


def read_json(path: Path) -> Dict[str, Any]:
    with path.open("r", encoding="utf-8") as handle:
        value = json.load(handle)
    if not isinstance(value, dict):
        raise ValueError("%s must contain a JSON object" % path)
    return value


def compose_prompt(task: LoadedTask) -> str:
    sections = [
        "Meridian Bench task %s (%s)." % (task.task["id"], task.task["lang"]),
        task.task["prompt"],
        "Primary-source context follows.",
    ]
    for relative, content in task.contexts:
        sections.extend(("--- %s ---" % relative, content))
    citation_instruction = (
        "Answer in the task language. When making a factual claim, attach the supporting source passage "
        "as an explicit quote (for example, 出处原句：\"...\" or Evidence: \"...\")."
    )
    if task.task.get("type") == "multi_doc":
        citation_instruction += (
            " For every quote, also state its exact source_file from the context heading "
            "(for example, source_file: context/example.txt)."
        )
    sections.append(citation_instruction)
    return "\n\n".join(sections)


def execute_run(
    tasks: Sequence[LoadedTask],
    adapter: AgentAdapter,
    agent_label: str,
    protocol: str,
    output_dir: Path,
    tasks_dir: Path,
) -> Dict[str, Any]:
    output_dir.mkdir(parents=True, exist_ok=True)
    response_dir = output_dir / "responses"
    records: List[Dict[str, Any]] = []
    for loaded in tasks:
        request_payload = {
            "prompt": compose_prompt(loaded),
            "task_id": loaded.task["id"],
            "lang": loaded.task["lang"],
            "type": loaded.task["type"],
        }
        try:
            result = adapter.run(request_payload)
            response_error = None if result.output.strip() else "agent returned empty output"
            record = {
                "task_id": loaded.task["id"],
                "lang": loaded.task["lang"],
                "output": result.output,
                "attempts": result.attempts,
                "error": response_error,
            }
        except AdapterError as exc:
            record = {
                "task_id": loaded.task["id"],
                "lang": loaded.task["lang"],
                "output": "",
                "attempts": None,
                "error": str(exc),
            }
        relative = Path("responses") / ("%s.%s.json" % (loaded.task["id"], loaded.task["lang"]))
        write_json(output_dir / relative, record)
        records.append(
            {
                "task_id": loaded.task["id"],
                "lang": loaded.task["lang"],
                "response_file": relative.as_posix(),
                "status": "failed" if record["error"] else "completed",
                "error": record["error"],
            }
        )
    failures = [
        {"task_id": item["task_id"], "lang": item["lang"], "reason": item["error"]}
        for item in records
        if item["status"] == "failed"
    ]
    manifest = {
        "schema_version": RUN_SCHEMA_VERSION,
        "created_at": datetime.now(timezone.utc).isoformat(),
        "agent": agent_label,
        "protocol": protocol,
        "tasks_dir": os.path.relpath(str(tasks_dir.resolve()), str(output_dir.resolve())),
        "tasks": records,
        "failed": len(failures),
        "failures": failures,
    }
    write_json(output_dir / "manifest.json", manifest)
    return manifest


def score_run(run_dir: Path, tasks_dir: Optional[Path] = None) -> Dict[str, Any]:
    manifest = read_json(run_dir / "manifest.json")
    if manifest.get("schema_version") != RUN_SCHEMA_VERSION:
        raise ValueError("unsupported run schema: %r" % manifest.get("schema_version"))
    selected_ids = [str(item["task_id"]) for item in manifest.get("tasks", [])]
    if tasks_dir is not None:
        source_tasks = tasks_dir
        stored_tasks_dir = os.path.relpath(str(tasks_dir.resolve()), str(run_dir.resolve()))
    else:
        stored = Path(str(manifest["tasks_dir"]))
        source_tasks = stored if stored.is_absolute() else run_dir / stored
        stored_tasks_dir = str(manifest["tasks_dir"])
    loaded = load_tasks(source_tasks, selected_ids=selected_ids)
    by_key = {(item.task["id"], item.task["lang"]): item for item in loaded}
    results: List[Dict[str, Any]] = []
    for item in manifest["tasks"]:
        task_id = str(item["task_id"])
        response = read_json(run_dir / str(item["response_file"]))
        lang = str(item.get("lang") or response.get("lang") or "")
        if not lang:
            raise ValueError("manifest task %s is missing lang" % task_id)
        key = (task_id, lang)
        if key not in by_key:
            raise ValueError("task instance not found: %s (%s)" % key)
        loaded_task = by_key[key]
        source_text = "\n".join(content for _, content in loaded_task.contexts)
        scored = score_task(
            loaded_task.task,
            loaded_task.gold,
            str(response.get("output", "")),
            source_text=source_text,
            error=response.get("error"),
        )
        scored["response_error"] = response.get("error")
        results.append(scored)
    scores = {
        "schema_version": "meridian-bench-scores-v1",
        "agent": manifest.get("agent"),
        "tasks_dir": stored_tasks_dir,
        "results": results,
    }
    write_json(run_dir / "scores.json", scores)
    return scores
