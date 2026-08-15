"""Small deterministic text helpers shared by the scorers."""

import re
import unicodedata

from .script_fold import fold_script
from difflib import SequenceMatcher
from typing import List, Set


_PUNCTUATION_RE = re.compile(r"[^\w\u3400-\u9fff]+", re.UNICODE)
_CJK_RE = re.compile(r"[\u3400-\u9fff]")


def normalize_text(value: str) -> str:
    # Script folding (Traditional→Simplified) applies to MATCHING only: a
    # zh-TW answer and a Simplified gold anchor describe the same fact in
    # different shapes. Verbatim-quote checks compare normalized forms of both
    # sides, so a quote copied byte-exact from a Simplified source still
    # matches its Simplified gold. Punishing shape was never the contract.
    value = unicodedata.normalize("NFKC", value).casefold()
    value = fold_script(value)
    return _PUNCTUATION_RE.sub("", value)


def contains_cjk(value: str) -> bool:
    return bool(_CJK_RE.search(value))


def semantic_units(value: str) -> Set[str]:
    """Return stable lexical units for rough checklist coverage.

    CJK runs become character bigrams, while other text becomes words. Numbers
    remain in the set, which matters for financial facts.
    """

    value = fold_script(unicodedata.normalize("NFKC", value).casefold())
    units: Set[str] = set(re.findall(r"[a-z]+(?:'[a-z]+)?|[-+]?\d[\d,.%/-]*", value))
    for run in re.findall(r"[\u3400-\u9fff]+", value):
        if len(run) == 1:
            units.add(run)
        else:
            units.update(run[index : index + 2] for index in range(len(run) - 1))
    return units


def coverage(reference: str, candidate: str) -> float:
    reference_units = semantic_units(reference)
    if not reference_units:
        return 1.0
    candidate_units = semantic_units(candidate)
    return len(reference_units & candidate_units) / len(reference_units)


def overlap(reference: str, candidate: str) -> float:
    """Measure whether a cited fragment overlaps a gold evidence fragment."""

    left = normalize_text(reference)
    right = normalize_text(candidate)
    if not left or not right:
        return 0.0
    if min(len(left), len(right)) < 4:
        return 1.0 if left == right else 0.0
    # Direction matters: the scoring contract asks whether the gold quote is
    # contained by the candidate citation. A longer verbatim citation is a full
    # match, including when the gold fragment itself is short.
    if left in right:
        return 1.0
    if right in left:
        return len(right) / len(left)
    match = SequenceMatcher(a=left, b=right, autojunk=False).find_longest_match()
    return match.size / len(left)


def split_nonempty_lines(value: str) -> List[str]:
    return [line.strip() for line in value.splitlines() if line.strip()]
