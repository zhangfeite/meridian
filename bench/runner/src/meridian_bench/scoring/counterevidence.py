"""Structural counter-evidence checks against gold point ids."""

import re
from typing import Any, Dict, Iterable, List

from .text import coverage, split_nonempty_lines


_MARKERS = re.compile(
    r"(?:反方证据|反面证据|相反证据|但|然而|不过|风险|不确定|"
    r"反方證據|反面證據|相反證據|然而|不過|風險|不確定|"
    r"counter[- ]evidence|on the other hand|however|risk|uncertain)",
    re.IGNORECASE,
)


def score_counterevidence(
    output: str,
    key_points: Iterable[Dict[str, Any]],
    required_ids: Iterable[str],
) -> Dict[str, Any]:
    points = {str(item["id"]): item for item in key_points}
    lines = split_nonempty_lines(output)
    checks: List[Dict[str, Any]] = []
    for point_id in required_ids:
        point = str(points.get(str(point_id), {}).get("point", ""))
        present = any(_MARKERS.search(line) and coverage(point, line) >= 0.25 for line in lines)
        checks.append({"point_id": str(point_id), "present": present})
    score = sum(1 for check in checks if check["present"]) / len(checks) if checks else 1.0
    return {"score": round(score, 6), "checks": checks}

