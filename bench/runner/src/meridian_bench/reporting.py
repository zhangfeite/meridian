"""Stable JSON and Markdown reports with dimensions by language."""

from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional

from .run import read_json, write_json
from .scoring import DIMENSIONS
from .tasks import LANGUAGES


def _mean(values: Iterable[float]) -> Optional[float]:
    items = list(values)
    return round(sum(items) / len(items), 6) if items else None


def build_report(scores: Dict[str, Any]) -> Dict[str, Any]:
    results = list(scores.get("results", []))
    failures = [
        {
            "task_id": result["task_id"],
            "lang": result["lang"],
            "reason": result.get("failure_reason") or "agent failed",
        }
        for result in results
        if result.get("status") == "failed"
    ]
    dimensions = {
        name: _mean(result["dimensions"][name] for result in results if name in result.get("dimensions", {}))
        for name in DIMENSIONS
    }
    by_language: Dict[str, Any] = {}
    matrix: Dict[str, Dict[str, Optional[float]]] = {name: {} for name in DIMENSIONS}
    for lang in LANGUAGES:
        language_results = [result for result in results if result.get("lang") == lang]
        lang_dimensions = {
            name: _mean(
                result["dimensions"][name]
                for result in language_results
                if name in result.get("dimensions", {})
            )
            for name in DIMENSIONS
        }
        by_language[lang] = {
            "tasks": len(language_results),
            "overall": _mean(float(result["overall"]) for result in language_results),
            "dimensions": lang_dimensions,
        }
        for name in DIMENSIONS:
            matrix[name][lang] = lang_dimensions[name]
    return {
        "schema_version": "meridian-bench-report-v1",
        "agent": scores.get("agent"),
        "tasks": len(results),
        "failed": len(failures),
        "failures": failures,
        "overall": _mean(float(result["overall"]) for result in results),
        "dimensions": dimensions,
        "by_language": by_language,
        "language_dimension_matrix": matrix,
        "task_scores": [
            {
                "task_id": result["task_id"],
                "lang": result["lang"],
                "overall": result["overall"],
                "dimensions": result["dimensions"],
                "status": result.get("status", "completed"),
                "failure_reason": result.get("failure_reason"),
            }
            for result in results
        ],
    }


def _format(value: Optional[float]) -> str:
    return "—" if value is None else "%.3f" % value


def report_markdown(report: Dict[str, Any]) -> str:
    lines = [
        "# Meridian Bench report",
        "",
        "- Agent: `%s`" % report.get("agent"),
        "- Tasks: %s" % report["tasks"],
        "- Failed: %s" % report["failed"],
        "- Overall: %s" % _format(report["overall"]),
        "",
        "## Dimension × language matrix",
        "",
        "| Dimension | All | zh-CN | zh-TW | en |",
        "|---|---:|---:|---:|---:|",
    ]
    for name in DIMENSIONS:
        row = report["language_dimension_matrix"][name]
        lines.append(
            "| %s | %s | %s | %s | %s |"
            % (name, _format(report["dimensions"][name]), _format(row["zh-CN"]), _format(row["zh-TW"]), _format(row["en"]))
        )
    lines.extend(
        (
            "",
            "## Task scores",
            "",
            "| Task | Language | Status | Overall | Dimensions |",
            "|---|---|---|---:|---|",
        )
    )
    for task in report["task_scores"]:
        detail = ", ".join("%s=%.3f" % (name, value) for name, value in task["dimensions"].items())
        lines.append(
            "| %s | %s | %s | %.3f | %s |"
            % (
                "%s (%s)" % (task["task_id"], task["lang"]),
                task["lang"],
                task["status"],
                task["overall"],
                detail,
            )
        )
    if report["failures"]:
        lines.extend(("", "## Failed tasks", ""))
        for failure in report["failures"]:
            reason = str(failure["reason"]).replace("\n", " ")
            lines.append("- `%s (%s)`: %s" % (failure["task_id"], failure["lang"], reason))
    return "\n".join(lines) + "\n"


def write_report(run_dir: Path) -> Dict[str, Any]:
    scores = read_json(run_dir / "scores.json")
    report = build_report(scores)
    write_json(run_dir / "report.json", report)
    (run_dir / "report.md").write_text(report_markdown(report), encoding="utf-8")
    return report
