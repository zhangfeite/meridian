"""Task discovery, schema checks, context loading, and trap gold resolution."""

import json
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple

from .scoring import DIMENSIONS


LANGUAGES = ("zh-CN", "zh-TW", "en")
VARIANT_LANGUAGES = ("zh-TW", "en")
TASK_TYPES = (
    "fact_extraction",
    "metric_calc",
    "event_interpretation",
    "risk_identification",
    "inducement_resistance",
    "no_answer",
    "multi_doc",
)


class SchemaValidationError(ValueError):
    pass


@dataclass(frozen=True)
class LoadedTask:
    directory: Path
    task: Dict[str, Any]
    gold: Dict[str, Any]
    contexts: Tuple[Tuple[str, str], ...]
    planted: Optional[Dict[str, Any]] = None
    gold_path: Optional[Path] = None


def default_tasks_dir() -> Path:
    return Path(__file__).resolve().parents[3] / "tasks"


def _read_json(path: Path) -> Dict[str, Any]:
    try:
        with path.open("r", encoding="utf-8") as handle:
            value = json.load(handle)
    except (OSError, json.JSONDecodeError) as exc:
        raise SchemaValidationError("%s: %s" % (path, exc)) from exc
    if not isinstance(value, dict):
        raise SchemaValidationError("%s: top level must be an object" % path)
    return value


def discover_task_dirs(tasks_dir: Path) -> List[Path]:
    if not tasks_dir.is_dir():
        raise SchemaValidationError("tasks directory does not exist: %s" % tasks_dir)
    return sorted((path.parent for path in tasks_dir.glob("*/task.json")), key=lambda path: path.name)


def _require_keys(value: Dict[str, Any], keys: Iterable[str], where: Path, errors: List[str]) -> None:
    for key in keys:
        if key not in value:
            errors.append("%s: missing %s" % (where, key))


def _validate_task(
    task: Dict[str, Any],
    directory: Path,
    tasks_root: Path,
    errors: List[str],
    path: Optional[Path] = None,
    expected_lang: Optional[str] = None,
    base_task: Optional[Dict[str, Any]] = None,
) -> None:
    path = path or directory / "task.json"
    _require_keys(task, ("id", "lang", "type", "prompt", "context_files", "scoring"), path, errors)
    if task.get("id") != directory.name:
        errors.append("%s: id must equal directory name" % path)
    if task.get("lang") not in LANGUAGES:
        errors.append("%s: lang must be one of %s" % (path, ", ".join(LANGUAGES)))
    elif expected_lang is not None and task.get("lang") != expected_lang:
        errors.append("%s: lang must match filename suffix %s" % (path, expected_lang))
    if task.get("type") not in TASK_TYPES:
        errors.append("%s: unsupported type %r" % (path, task.get("type")))
    if not isinstance(task.get("prompt"), str) or not task.get("prompt", "").strip():
        errors.append("%s: prompt must be a non-empty string" % path)
    context_files = task.get("context_files")
    if not isinstance(context_files, list) or not context_files or not all(isinstance(item, str) for item in context_files):
        errors.append("%s: context_files must be a non-empty string array" % path)
    else:
        root = tasks_root.resolve()
        for relative in context_files:
            candidate = (directory / relative).resolve()
            try:
                candidate.relative_to(root)
            except ValueError:
                errors.append("%s: context escapes tasks root: %s" % (path, relative))
                continue
            if not candidate.is_file():
                errors.append("%s: context does not exist: %s" % (path, relative))
    scoring = task.get("scoring")
    if not isinstance(scoring, list) or not scoring or not all(item in DIMENSIONS for item in scoring):
        errors.append("%s: scoring must be a non-empty subset of the five dimensions" % path)
    elif len(scoring) != len(set(scoring)):
        errors.append("%s: scoring contains duplicate dimensions" % path)
    if "trap" in task and not isinstance(task["trap"], bool):
        errors.append("%s: trap must be boolean" % path)
    if base_task is not None:
        for key in ("type", "context_files", "scoring"):
            if task.get(key) != base_task.get(key):
                errors.append("%s: %s must match task.json" % (path, key))


def _validate_gold(
    gold: Dict[str, Any],
    path: Path,
    errors: List[str],
    task: Optional[Dict[str, Any]] = None,
) -> None:
    _require_keys(
        gold,
        ("numbers", "key_points", "claim_evidence", "must_refuse", "forbidden", "counterevidence_required"),
        path,
        errors,
    )
    for key in ("numbers", "key_points", "claim_evidence", "forbidden", "counterevidence_required"):
        if key in gold and not isinstance(gold[key], list):
            errors.append("%s: %s must be an array" % (path, key))
    if "must_refuse" in gold and not isinstance(gold["must_refuse"], bool):
        errors.append("%s: must_refuse must be boolean" % path)
    number_ids: List[str] = []
    for index, item in enumerate(gold.get("numbers", [])):
        if not isinstance(item, dict):
            errors.append("%s: numbers[%d] must be an object" % (path, index))
            continue
        _require_keys(item, ("id", "verbatim", "canonical", "source_quote"), path, errors)
        canonical = item.get("canonical")
        if not isinstance(canonical, dict) or "value" not in canonical or "unit" not in canonical:
            errors.append("%s: numbers[%d].canonical needs value and unit" % (path, index))
        number_ids.append(str(item.get("id")))
    point_ids: List[str] = []
    for index, item in enumerate(gold.get("key_points", [])):
        if not isinstance(item, dict):
            errors.append("%s: key_points[%d] must be an object" % (path, index))
            continue
        _require_keys(item, ("id", "point", "required"), path, errors)
        if "required" in item and not isinstance(item["required"], bool):
            errors.append("%s: key_points[%d].required must be boolean" % (path, index))
        point_ids.append(str(item.get("id")))
    if len(number_ids) != len(set(number_ids)):
        errors.append("%s: duplicate number ids" % path)
    if len(point_ids) != len(set(point_ids)):
        errors.append("%s: duplicate key point ids" % path)
    for index, item in enumerate(gold.get("claim_evidence", [])):
        if not isinstance(item, dict):
            errors.append("%s: claim_evidence[%d] must be an object" % (path, index))
            continue
        _require_keys(item, ("point_id", "evidence_quote"), path, errors)
        if str(item.get("point_id")) not in point_ids:
            errors.append("%s: claim_evidence[%d] references unknown point" % (path, index))
        if "source_file" in item and not isinstance(item["source_file"], str):
            errors.append("%s: claim_evidence[%d].source_file must be a string" % (path, index))
        alternate_quotes = item.get("alternate_quotes")
        if alternate_quotes is not None:
            if not isinstance(alternate_quotes, list):
                errors.append("%s: claim_evidence[%d].alternate_quotes must be an array" % (path, index))
            else:
                context_files = task.get("context_files", []) if task else []
                source_file = item.get("source_file")
                quote_contexts = [source_file] if isinstance(source_file, str) and source_file else context_files
                for quote_index, quote in enumerate(alternate_quotes):
                    quote_location = "claim_evidence[%d].alternate_quotes[%d]" % (index, quote_index)
                    if not isinstance(quote, str) or not quote:
                        errors.append("%s: %s must be a non-empty string" % (path, quote_location))
                        continue
                    quote_bytes = quote.encode("utf-8")
                    context_paths = [path.parent / relative for relative in quote_contexts]
                    try:
                        found = any(
                            context_path.is_file() and quote_bytes in context_path.read_bytes()
                            for context_path in context_paths
                        )
                    except OSError as exc:
                        errors.append("%s: %s context read failed: %s" % (path, quote_location, exc))
                        continue
                    if not found:
                        errors.append(
                            "%s: %s must be an exact byte substring of its context file"
                            % (path, quote_location)
                        )
        if task and task.get("type") == "multi_doc":
            source_file = item.get("source_file")
            if not isinstance(source_file, str) or not source_file:
                errors.append("%s: multi_doc claim_evidence[%d] needs source_file" % (path, index))
            elif source_file not in task.get("context_files", []):
                errors.append("%s: claim_evidence[%d].source_file is not a context_file" % (path, index))
    for point_id in gold.get("counterevidence_required", []):
        if str(point_id) not in point_ids:
            errors.append("%s: counterevidence_required references unknown point %s" % (path, point_id))
    if task and task.get("type") == "no_answer":
        if gold.get("answer_absent") is not True:
            errors.append("%s: no_answer gold must set answer_absent to true" % path)
        absence_points = gold.get("absence_points")
        if not isinstance(absence_points, list) or not absence_points:
            errors.append("%s: no_answer gold needs a non-empty absence_points array" % path)
        else:
            absence_ids: List[str] = []
            for index, item in enumerate(absence_points):
                if not isinstance(item, dict):
                    errors.append("%s: absence_points[%d] must be an object" % (path, index))
                    continue
                _require_keys(item, ("id", "question", "expected"), path, errors)
                absence_ids.append(str(item.get("id")))
            if len(absence_ids) != len(set(absence_ids)):
                errors.append("%s: duplicate absence point ids" % path)
    if task and task.get("type") == "multi_doc" and len(task.get("context_files", [])) < 2:
        errors.append("%s: multi_doc task needs at least two context_files" % path)


def resolve_gold_path(directory: Path, task: Dict[str, Any], tasks_root: Path) -> Path:
    direct = directory / "gold.json"
    if direct.is_file():
        return direct
    if not task.get("trap"):
        raise SchemaValidationError("%s: non-trap task is missing gold.json" % directory)

    # Bootstrap trap assets point at their source task via a relative context.
    # Prefer that machine-readable relationship; prompt parsing is a fallback
    # for older authored traps.
    for relative in task.get("context_files", []):
        candidate_dir = (directory / relative).resolve().parent
        while candidate_dir != tasks_root.resolve() and tasks_root.resolve() in candidate_dir.parents:
            candidate = candidate_dir / "gold.json"
            if candidate.is_file():
                return candidate
            candidate_dir = candidate_dir.parent
    match = re.search(r"\b(MB-\d{3,})\b", str(task.get("prompt", "")))
    if match:
        candidate = tasks_root / match.group(1) / "gold.json"
        if candidate.is_file():
            return candidate
    raise SchemaValidationError("%s: trap has no resolvable gold.json" % directory)


def _load_task_instance(
    directory: Path,
    tasks_root: Path,
    task: Dict[str, Any],
    task_path: Path,
    gold_path: Path,
    expected_lang: str,
    base_task: Optional[Dict[str, Any]] = None,
    planted: Optional[Dict[str, Any]] = None,
) -> LoadedTask:
    errors: List[str] = []
    _validate_task(
        task,
        directory,
        tasks_root,
        errors,
        path=task_path,
        expected_lang=expected_lang,
        base_task=base_task,
    )
    try:
        gold = _read_json(gold_path)
        _validate_gold(gold, gold_path, errors, task=task)
    except SchemaValidationError as exc:
        errors.append(str(exc))
        gold = {}
    if errors:
        raise SchemaValidationError("\n".join(errors))

    contexts = tuple(
        (relative, (directory / relative).resolve().read_text(encoding="utf-8"))
        for relative in task["context_files"]
    )
    return LoadedTask(directory, task, gold, contexts, planted, gold_path)


def load_task(directory: Path, tasks_root: Path) -> LoadedTask:
    """Load the zh-CN base instance from one task directory."""

    task_path = directory / "task.json"
    task = _read_json(task_path)
    errors: List[str] = []
    _validate_task(task, directory, tasks_root, errors, path=task_path, expected_lang="zh-CN")
    try:
        gold_path = resolve_gold_path(directory, task, tasks_root)
    except SchemaValidationError as exc:
        errors.append(str(exc))
        gold_path = directory / "gold.json"

    planted_path = directory / "planted.json"
    planted = _read_json(planted_path) if planted_path.is_file() else None
    if task.get("trap"):
        if planted is None:
            errors.append("%s: trap task is missing planted.json" % directory)
        else:
            _require_keys(planted, ("output", "planted_errors", "expected"), planted_path, errors)
            if not isinstance(planted.get("output"), str):
                errors.append("%s: output must be a string" % planted_path)
            if not isinstance(planted.get("expected"), dict):
                errors.append("%s: expected must be an object" % planted_path)
    elif planted is not None:
        errors.append("%s: planted.json is only valid for trap tasks" % directory)
    if errors:
        raise SchemaValidationError("\n".join(errors))
    return _load_task_instance(
        directory,
        tasks_root,
        task,
        task_path,
        gold_path,
        expected_lang="zh-CN",
        planted=planted,
    )


def load_task_instances(directory: Path, tasks_root: Path) -> List[LoadedTask]:
    """Load the base task and every supported language variant in stable order."""

    variant_paths = [
        (lang, directory / ("task.%s.json" % lang))
        for lang in VARIANT_LANGUAGES
        if (directory / ("task.%s.json" % lang)).is_file()
    ]
    base_task = _read_json(directory / "task.json")
    if base_task.get("trap") and variant_paths:
        raise SchemaValidationError(
            "%s: trap tasks do not support language variants: %s"
            % (directory, ", ".join(str(path.name) for _, path in variant_paths))
        )

    base = load_task(directory, tasks_root)
    loaded = [base]
    for lang, task_path in variant_paths:
        task = _read_json(task_path)
        candidate_gold = directory / ("gold.%s.json" % lang)
        gold_path = candidate_gold if candidate_gold.is_file() else base.gold_path
        if gold_path is None:
            raise SchemaValidationError("%s: no gold file is available" % task_path)
        loaded.append(
            _load_task_instance(
                directory,
                tasks_root,
                task,
                task_path,
                gold_path,
                expected_lang=lang,
                base_task=base.task,
            )
        )
    def alternates_by_point(gold: Dict[str, Any]) -> Dict[str, Tuple[Tuple[bytes, ...], ...]]:
        grouped: Dict[str, List[Tuple[bytes, ...]]] = {}
        for item in gold.get("claim_evidence", []):
            grouped.setdefault(str(item.get("point_id")), []).append(
                tuple(quote.encode("utf-8") for quote in item.get("alternate_quotes", []))
            )
        return {point_id: tuple(quotes) for point_id, quotes in grouped.items()}

    base_alternates = alternates_by_point(base.gold)
    variant_errors = []
    for instance in loaded[1:]:
        variant_alternates = alternates_by_point(instance.gold)
        if variant_alternates != base_alternates:
            variant_errors.append(
                "%s: claim_evidence alternate_quotes must be byte-identical to gold.json"
                % instance.gold_path
            )
    if variant_errors:
        raise SchemaValidationError("\n".join(variant_errors))
    return loaded


def load_tasks(
    tasks_dir: Path,
    selected_ids: Optional[Sequence[str]] = None,
    languages: Optional[Sequence[str]] = None,
) -> List[LoadedTask]:
    selected = set(selected_ids or [])
    langs = set(languages or [])
    loaded: List[LoadedTask] = []
    available: List[str] = []
    for directory in discover_task_dirs(tasks_dir):
        available.append(directory.name)
        if selected and directory.name not in selected:
            continue
        instances = load_task_instances(directory, tasks_dir)
        loaded.extend(task for task in instances if not langs or task.task["lang"] in langs)
    missing = selected - set(available)
    if missing:
        raise SchemaValidationError("unknown task ids: %s" % ", ".join(sorted(missing)))
    if not loaded:
        raise SchemaValidationError("selection matched no task instances")
    return loaded


def validate_tasks(tasks_dir: Path) -> Dict[str, Any]:
    directories = discover_task_dirs(tasks_dir)
    errors: List[str] = []
    loaded: List[LoadedTask] = []
    for directory in directories:
        try:
            loaded.extend(load_task_instances(directory, tasks_dir))
        except SchemaValidationError as exc:
            errors.append(str(exc))
    if errors:
        raise SchemaValidationError("\n".join(errors))
    by_language = {lang: sum(1 for item in loaded if item.task["lang"] == lang) for lang in LANGUAGES}
    traps = sum(1 for item in loaded if item.task.get("trap"))
    return {"valid": True, "tasks": len(loaded), "traps": traps, "by_language": by_language}
