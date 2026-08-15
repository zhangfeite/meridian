"""Claim-to-evidence alignment scoring for plain-text agent answers."""

import re
import unicodedata
from typing import Any, Dict, Iterable, List, Optional, Tuple

from .text import coverage, overlap, semantic_units, split_nonempty_lines


_QUOTED_PATTERNS = [
    # Per-delimiter pairing: 「…」 may legitimately contain nested “…” (e.g.
    # 以下简称“公司”) — a combined character class would close at the first
    # inner curly quote and truncate the citation (real MB-001 failure).
    re.compile(r"「([^「」]+)」", re.DOTALL),
    re.compile(r"『([^『』]+)』", re.DOTALL),
    re.compile(r"“([^“”]+)”", re.DOTALL),
    re.compile(r'"([^"\n]{4,})"'),
    re.compile(
        r"(?:出处原句|出处|原文|source|evidence|quote)\s*[:：]\s*(?![“「『\"])([^\n。；;\]]+)",
        re.IGNORECASE,
    ),
]

_SOURCE_FILE_RE = re.compile(
    r"(?:\.{0,2}[/\\])?context[/\\][A-Za-z0-9_.-]+\.txt|"
    r"(?:source[_\s-]*file|来源文件|來源檔案|出处文件|出處檔案)"
    r"\s*[:=：]\s*[“”「」『』\"']?([A-Za-z0-9_.\\/-]+\.txt)|"
    r"[A-Za-z0-9_-]+\.txt",
    re.IGNORECASE,
)

_DIRECTION_CONFLICTS = [
    (
        re.compile(r"(?:尚未|未曾|没有|沒有|not yet|has not|have not)", re.IGNORECASE),
        re.compile(r"(?:已(?:经|經)?进入|已(?:经|經)?受理|已获批准|已獲批准|has entered|was accepted|has been accepted)", re.IGNORECASE),
    ),
    (
        re.compile(r"(?:不确定|不確定|uncertain|uncertainty)", re.IGNORECASE),
        re.compile(r"(?:肯定|必然|确定会|確定會|一定会|一定會|definitely|certain to|will surely)", re.IGNORECASE),
    ),
]


def extract_citations(output: str) -> List[str]:
    citations: List[str] = []
    for pattern in _QUOTED_PATTERNS:
        citations.extend(match.group(1).strip() for match in pattern.finditer(output) if match.group(1).strip())
    citations.extend(line[1:].strip() for line in split_nonempty_lines(output) if line.startswith(">") and line[1:].strip())
    # Preserve first occurrence order while removing exact duplicates.
    return list(dict.fromkeys(citations))


def _claim_before(output: str, start: int) -> str:
    prefix = output[:start]
    current_line = prefix.rsplit("\n", 1)[-1].strip()
    claim = re.sub(
        r"(?:[-*\s]*\[?\s*)?(?:出处原句|出处|原文|source|evidence|quote)\s*[:：]?\s*$",
        "",
        current_line,
        flags=re.IGNORECASE,
    ).strip()
    generic_lead = re.fullmatch(r"[-*\s]*(?:(?:公告)?(?:明确|指出|称))[:：\s]*", claim)
    if semantic_units(claim) and not generic_lead:
        return claim
    # Explicit evidence markers commonly occupy their own line. Bind them to
    # the nearest preceding non-empty claim line rather than to the marker.
    for line in reversed(prefix.splitlines()[:-1]):
        candidate = line.strip()
        if candidate and candidate != "---" and not re.fullmatch(r"[-*\s]+", candidate):
            return (candidate + " " + claim).strip()
    return claim


def extract_citation_pairs(output: str) -> List[Tuple[str, str]]:
    pairs: List[Tuple[str, str]] = []
    for pattern in _QUOTED_PATTERNS:
        for match in pattern.finditer(output):
            citation = match.group(1).strip()
            if citation:
                pairs.append((_claim_before(output, match.start()), citation))
    for match in re.finditer(r"^>\s*(.+)$", output, re.MULTILINE):
        pairs.append((_claim_before(output, match.start()), match.group(1).strip()))
    return list(dict.fromkeys(pairs))


def _normalize_source_file(value: str) -> str:
    value = unicodedata.normalize("NFKC", value).strip().replace("\\", "/").casefold()
    while value.startswith("./"):
        value = value[2:]
    return value


_SIGIL_RE = re.compile(r"\b([A-Z][A-Za-z0-9]{0,3}-[A-Z0-9]{1,4})\b")


def _extract_source_legend(output: str) -> Dict[str, str]:
    """Map source sigils (``S-A``) to context files from legend lines.

    A memo may define its sources once (``S-A: context/abnormal_move.txt — 《…》``)
    and cite with the sigil only. Any line holding both a sigil and a
    recognizable file token establishes the mapping.
    """
    legend: Dict[str, str] = {}
    for line in output.splitlines():
        sigils = _SIGIL_RE.findall(line)
        if not sigils:
            continue
        file_match = re.search(
            r"(?:\.{0,2}[/\\])?context[/\\][A-Za-z0-9_.-]+\.txt|[A-Za-z0-9_-]+\.txt",
            line,
            re.IGNORECASE,
        )
        if not file_match:
            continue
        path = _normalize_source_file(file_match.group(0))
        for sigil in sigils:
            legend.setdefault(sigil, path)
    return legend


def _source_file_matches(cited: str, expected: str) -> bool:
    """Exact normalized match, or bare-basename match ("abnormal_move.txt").

    Task context files live in a flat context/ directory, so basenames are
    unambiguous within a task; a wrong basename still fails (trap MB-T04).
    """
    if not cited:
        return False
    if cited == expected:
        return True
    return cited.rsplit("/", 1)[-1] == expected.rsplit("/", 1)[-1]


def _source_file_near(output: str, start: int, end: int, legend: Optional[Dict[str, str]] = None) -> str:
    line_start = output.rfind("\n", 0, start) + 1
    line_end = output.find("\n", end)
    if line_end < 0:
        line_end = len(output)
    windows = [(line_start, line_end)]
    # A source label is also commonly put on the line immediately before a
    # blockquote, or on the line immediately after the quote
    # ("source_file: context/x.txt"). Do not scan farther in either direction:
    # that could steal another claim's file.
    previous_start = output.rfind("\n", 0, max(0, line_start - 1)) + 1
    if previous_start < line_start:
        windows.append((previous_start, line_end))
    next_end = output.find("\n", line_end + 1)
    if next_end < 0:
        next_end = len(output)
    if next_end > line_end:
        windows.append((line_end, next_end))
    candidates: List[Tuple[int, str]] = []
    for window_start, window_end in windows:
        for match in _SOURCE_FILE_RE.finditer(output[window_start:window_end]):
            raw = match.group(1) or match.group(0)
            path_match = re.search(r"(?:\.{0,2}[/\\])?context[/\\][A-Za-z0-9_.-]+\.txt", raw, re.IGNORECASE)
            path = path_match.group(0) if path_match else raw
            absolute_start = window_start + match.start()
            distance = min(abs(absolute_start - start), abs(absolute_start - end))
            candidates.append((distance, _normalize_source_file(path)))
    if legend:
        for window_start, window_end in windows:
            for match in _SIGIL_RE.finditer(output[window_start:window_end]):
                mapped = legend.get(match.group(1))
                if mapped:
                    absolute_start = window_start + match.start()
                    distance = min(abs(absolute_start - start), abs(absolute_start - end))
                    candidates.append((distance, mapped))
    return min(candidates, default=(0, ""), key=lambda item: item[0])[1]


def extract_citation_records(output: str) -> List[Dict[str, str]]:
    legend = _extract_source_legend(output)
    records: List[Dict[str, str]] = []
    for pattern in _QUOTED_PATTERNS:
        for match in pattern.finditer(output):
            citation = match.group(1).strip()
            if citation:
                records.append(
                    {
                        "claim": _claim_before(output, match.start()),
                        "citation": citation,
                        "source_file": _source_file_near(output, match.start(), match.end(), legend),
                    }
                )
    for match in re.finditer(r"^>\s*(.+)$", output, re.MULTILINE):
        records.append(
            {
                "claim": _claim_before(output, match.start()),
                "citation": match.group(1).strip(),
                "source_file": _source_file_near(output, match.start(), match.end(), legend),
            }
        )
    unique: List[Dict[str, str]] = []
    seen = set()
    for record in records:
        key = (record["claim"], record["citation"], record["source_file"])
        if key not in seen:
            seen.add(key)
            unique.append(record)
    return unique


def _direction_conflict(point: str, evidence: str, output: str) -> bool:
    gold_text = point + " " + evidence
    return any(gold.search(gold_text) and bad.search(output) for gold, bad in _DIRECTION_CONFLICTS)


def score_citation_alignment(
    output: str,
    key_points: Iterable[Dict[str, Any]],
    claim_evidence: Iterable[Dict[str, Any]],
) -> Dict[str, Any]:
    points = {item["id"]: item for item in key_points}
    records = extract_citation_records(output)
    citations = list(dict.fromkeys(record["citation"] for record in records))
    checks: List[Dict[str, Any]] = []

    for expected in claim_evidence:
        point = points.get(expected["point_id"], {"point": "", "required": True})
        point_coverage = coverage(str(point.get("point", "")), output)
        # Required facts always need aligned evidence. Optional facts only enter
        # the denominator if the answer appears to make that claim.
        applicable = bool(point.get("required")) or point_coverage >= 0.45
        if not applicable:
            continue
        evidence = str(expected["evidence_quote"])
        point_text = str(point.get("point", ""))
        pairwise = [
            {
                "claim_coverage": coverage(point_text, record["claim"]),
                "claim_shared_units": len(semantic_units(point_text) & semantic_units(record["claim"])),
                "citation_point_coverage": coverage(point_text, record["citation"]),
                "evidence_overlap": overlap(evidence, record["citation"]),
                "source_file": record["source_file"],
            }
            for record in records
        ]
        # Compare every extracted claim/citation pair. Relevance remains bound
        # to that pair so a correct quote attached to the wrong claim (MB-T02)
        # cannot satisfy a different point.
        eligible = [
            item
            for item in pairwise
            if item["claim_coverage"] >= 0.25
            or item["claim_shared_units"] >= 3
            or item["citation_point_coverage"] >= 0.3
        ]
        best = max((item["evidence_overlap"] for item in eligible), default=0.0)
        expected_source = _normalize_source_file(str(expected.get("source_file", "")))
        if expected_source:
            source_eligible = [item for item in eligible if _source_file_matches(item["source_file"], expected_source)]
            best_with_source = max((item["evidence_overlap"] for item in source_eligible), default=0.0)
            source_match = best_with_source >= 0.45
        else:
            best_with_source = best
            source_match = True
        conflict = _direction_conflict(str(point.get("point", "")), evidence, output)
        aligned = best_with_source >= 0.45 and not conflict
        checks.append(
            {
                "point_id": expected["point_id"],
                "aligned": aligned,
                "best_overlap": round(best, 6),
                "best_overlap_with_source": round(best_with_source, 6),
                "direction_conflict": conflict,
                "candidate_pairs": len(records),
                "expected_source_file": expected_source or None,
                "cited_source_files": list(
                    dict.fromkeys(item["source_file"] for item in eligible if item["source_file"])
                ),
                "source_file_match": source_match,
                "quote_match_wrong_source": bool(expected_source and best >= 0.45 and not source_match),
            }
        )

    if not checks:
        score = 1.0
    else:
        score = sum(1 for check in checks if check["aligned"]) / len(checks)
        if any(check["direction_conflict"] for check in checks):
            score = min(score, 0.5)
    return {"score": round(score, 6), "citations": citations, "checks": checks}
