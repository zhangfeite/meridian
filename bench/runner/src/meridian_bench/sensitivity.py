"""Trap-sample self-checks used by CLI validation and CI tests."""

from pathlib import Path
from typing import Any, Dict, List

from .scoring import score_task
from .tasks import load_tasks


class SensitivityError(AssertionError):
    pass


def check_traps(tasks_dir: Path) -> Dict[str, Any]:
    traps = [item for item in load_tasks(tasks_dir) if item.task.get("trap")]
    results: List[Dict[str, Any]] = []
    failures: List[str] = []
    for trap in traps:
        assert trap.planted is not None
        source_text = "\n".join(content for _, content in trap.contexts)
        scored = score_task(trap.task, trap.gold, str(trap.planted["output"]), source_text=source_text)
        expected = trap.planted["expected"]
        checks: Dict[str, bool] = {}
        for key, limit in expected.items():
            if key == "overall_max":
                checks[key] = float(scored["overall"]) <= float(limit)
            elif key == "overall_min":
                checks[key] = float(scored["overall"]) >= float(limit)
            elif key.endswith("_max"):
                dimension = key[: -len("_max")]
                actual = float(scored["dimensions"][dimension])
                checks[key] = actual <= float(limit)
            elif key.endswith("_min"):
                dimension = key[: -len("_min")]
                actual = float(scored["dimensions"][dimension])
                checks[key] = actual >= float(limit)
            elif key == "compliance" and str(limit) == "fail":
                checks[key] = scored["details"]["compliance"]["status"] == "fail"
            elif key == "absence_hard_failure":
                checks[key] = bool(scored["details"].get("absence", {}).get("hard_failure")) is bool(limit)
            elif key == "wrong_source_point":
                citation_checks = scored["details"]["citation_alignment"]["checks"]
                checks[key] = any(
                    item["point_id"] == str(limit)
                    and not item["aligned"]
                    and item.get("quote_match_wrong_source")
                    for item in citation_checks
                )
            elif key in scored["dimensions"]:
                checks[key] = abs(float(scored["dimensions"][key]) - float(limit)) < 0.000001
            else:
                failures.append("%s: unsupported expected check %s" % (trap.task["id"], key))
        if not all(checks.values()):
            failures.append("%s failed expected limits: %r" % (trap.task["id"], checks))
        results.append(
            {
                "task_id": trap.task["id"],
                "overall": scored["overall"],
                "dimensions": scored["dimensions"],
                "checks": checks,
            }
        )
    if not traps:
        failures.append("no trap tasks found")
    if failures:
        raise SensitivityError("\n".join(failures))
    return {"valid": True, "traps": len(traps), "results": results}
