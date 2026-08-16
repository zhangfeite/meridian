"""Independent numeric fidelity scorer for public Meridian Bench data.

This module intentionally depends only on the Python standard library and was
written for Meridian Bench. It does not import or share implementation with any
Periscope service.
"""

import re
import unicodedata
from dataclasses import asdict, dataclass
from decimal import Decimal, InvalidOperation
from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple


@dataclass(frozen=True)
class NumberToken:
    raw: str
    kind: str
    value: str
    unit: str
    numeric_raw: Optional[str] = None
    multiplier: Optional[str] = None


_DOC_RE = re.compile(r"[（(]\s*\d{4}\s*[）)]\s*[^，。；;\n]{0,24}?\d+\s*[号號]", re.IGNORECASE)
_DATE_CN_RE = re.compile(r"(?<!\d)\d{4}\s*年\s*\d{1,2}\s*月\s*\d{1,2}\s*日")
_DATE_ISO_RE = re.compile(r"(?<!\d)\d{4}[-/]\d{1,2}[-/]\d{1,2}(?!\d)")
_MONTH_NAMES = (
    "January|February|March|April|May|June|July|August|September|October|November|December"
)
_DATE_EN_RE = re.compile(
    rf"\b(?:"
    rf"(?P<month_first>{_MONTH_NAMES})\s+(?P<day_first>\d{{1,2}})(?:\s*,\s*|\s+)(?P<year_first>\d{{4}})"
    rf"|"
    rf"(?P<day_last>\d{{1,2}})\s+(?P<month_last>{_MONTH_NAMES})(?:\s*,\s*|\s+)(?P<year_last>\d{{4}})"
    rf")\b",
    re.IGNORECASE,
)
_PREFIX_AMOUNT_RE = re.compile(
    r"(?P<prefix>[$¥￥]|CNY|RMB|USD|HKD)\s*(?P<number>[-+]?\d[\d,]*(?:\.\d+)?)\s*"
    r"(?P<scale>billion|million|thousand)?",
    re.IGNORECASE,
)
_AMOUNT_RE = re.compile(
    r"(?<![\d.])(?P<number>[-+]?\d[\d,]*(?:\.\d+)?)\s*"
    r"(?P<unit>万亿元|萬億元|亿元|億元|万元|萬元|千元|百万元|百萬元|元人民币|元人民幣|人民币|人民幣|元|万港元|萬港元|港元|"
    r"万美元|萬美元|美元|million\s+(?:yuan|rmb|cny|dollars?)|"
    r"billion\s+(?:yuan|rmb|cny|dollars?)|yuan|(?:cny|rmb|usd|hkd))(?![a-zA-Z])",
    re.IGNORECASE,
)
_PERCENT_RE = re.compile(r"(?<![\d.])[-+]?\d[\d,]*(?:\.\d+)?\s*(?:%|％|percent|百分[点點])", re.IGNORECASE)
_SCALAR_RE = re.compile(
    r"(?<![\d.,])[-+]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?(?:\s*倍)?(?!\.?\d)"
)


_UNIT_MAP: Dict[str, Tuple[str, Decimal]] = {
    "元": ("CNY", Decimal("1")),
    "元人民币": ("CNY", Decimal("1")),
    "人民币": ("CNY", Decimal("1")),
    "万元": ("CNY", Decimal("10000")),
    "千元": ("CNY", Decimal("1000")),
    "百万元": ("CNY", Decimal("1000000")),
    "亿元": ("CNY", Decimal("100000000")),
    "万亿元": ("CNY", Decimal("1000000000000")),
    "cny": ("CNY", Decimal("1")),
    "yuan": ("CNY", Decimal("1")),
    "rmb": ("CNY", Decimal("1")),
    "million yuan": ("CNY", Decimal("1000000")),
    "million rmb": ("CNY", Decimal("1000000")),
    "million cny": ("CNY", Decimal("1000000")),
    "billion yuan": ("CNY", Decimal("1000000000")),
    "billion rmb": ("CNY", Decimal("1000000000")),
    "billion cny": ("CNY", Decimal("1000000000")),
    "美元": ("USD", Decimal("1")),
    "万美元": ("USD", Decimal("10000")),
    "usd": ("USD", Decimal("1")),
    "million dollars": ("USD", Decimal("1000000")),
    "million dollar": ("USD", Decimal("1000000")),
    "billion dollars": ("USD", Decimal("1000000000")),
    "billion dollar": ("USD", Decimal("1000000000")),
    "港元": ("HKD", Decimal("1")),
    "万港元": ("HKD", Decimal("10000")),
    "hkd": ("HKD", Decimal("1")),
}


def _decimal(value: str) -> Decimal:
    return Decimal(value.replace(",", "").strip())


def _decimal_string(value: Decimal) -> str:
    normalized = value.normalize()
    rendered = format(normalized, "f")
    return "0" if rendered in {"-0", ""} else rendered


def _normalize_doc(value: str) -> str:
    return unicodedata.normalize("NFKC", re.sub(r"\s+", "", value)).casefold()


def _date_token(raw: str) -> NumberToken:
    digits = [int(item) for item in re.findall(r"\d+", raw)]
    return NumberToken(raw=raw, kind="date", value="%04d-%02d-%02d" % tuple(digits), unit="date")


_MONTH_VALUES = {
    name.casefold(): index
    for index, name in enumerate(
        (
            "January", "February", "March", "April", "May", "June",
            "July", "August", "September", "October", "November", "December",
        ),
        start=1,
    )
}


def _english_date_token(match: re.Match[str]) -> NumberToken:
    if match.group("month_first") is not None:
        month = match.group("month_first")
        day = match.group("day_first")
        year = match.group("year_first")
    else:
        month = match.group("month_last")
        day = match.group("day_last")
        year = match.group("year_last")
    return NumberToken(
        raw=match.group(0),
        kind="date",
        value="%04d-%02d-%02d" % (int(year), _MONTH_VALUES[month.casefold()], int(day)),
        unit="date",
    )


_TRADITIONAL_UNIT_CHARS = str.maketrans("萬億幣", "万亿币")


def _amount_token(raw: str, numeric: str, unit_label: str) -> NumberToken:
    label = re.sub(r"\s+", " ", unit_label.strip().casefold()).translate(_TRADITIONAL_UNIT_CHARS)
    unit, multiplier = _UNIT_MAP[label]
    numeric_value = _decimal(numeric)
    return NumberToken(
        raw=raw,
        kind="amount",
        value=_decimal_string(numeric_value * multiplier),
        unit=unit,
        numeric_raw=_decimal_string(numeric_value),
        multiplier=_decimal_string(multiplier),
    )


def _prefix_amount_token(match: re.Match[str]) -> NumberToken:
    prefix = match.group("prefix")
    scale = (match.group("scale") or "").casefold()
    prefix_key = prefix.upper()
    unit = {"$": "USD", "USD": "USD", "HKD": "HKD"}.get(prefix_key, "CNY")
    multiplier = {"": Decimal("1"), "thousand": Decimal("1000"), "million": Decimal("1000000"), "billion": Decimal("1000000000")}[scale]
    numeric_value = _decimal(match.group("number"))
    return NumberToken(
        raw=match.group(0),
        kind="amount",
        value=_decimal_string(numeric_value * multiplier),
        unit=unit,
        numeric_raw=_decimal_string(numeric_value),
        multiplier=_decimal_string(multiplier),
    )


def _overlaps(span: Tuple[int, int], occupied: Sequence[Tuple[int, int]]) -> bool:
    return any(span[0] < other[1] and other[0] < span[1] for other in occupied)


def extract_numbers(text: str) -> List[NumberToken]:
    """Extract compound financial numbers without double-counting their digits."""

    found: List[Tuple[int, int, NumberToken]] = []
    occupied: List[Tuple[int, int]] = []

    def add(pattern: re.Pattern[str], factory: Any) -> None:
        for match in pattern.finditer(text):
            if _overlaps(match.span(), occupied):
                continue
            try:
                token = factory(match)
            except (InvalidOperation, KeyError, ValueError):
                continue
            found.append((match.start(), match.end(), token))
            occupied.append(match.span())

    add(_DOC_RE, lambda match: NumberToken(match.group(0), "doc_no", _normalize_doc(match.group(0)), "doc_no"))
    add(_DATE_CN_RE, lambda match: _date_token(match.group(0)))
    add(_DATE_ISO_RE, lambda match: _date_token(match.group(0)))
    add(_DATE_EN_RE, _english_date_token)
    add(_PREFIX_AMOUNT_RE, _prefix_amount_token)
    add(_AMOUNT_RE, lambda match: _amount_token(match.group(0), match.group("number"), match.group("unit")))
    add(
        _PERCENT_RE,
        lambda match: NumberToken(
            match.group(0), "percent", _decimal_string(_decimal(re.findall(r"[-+]?\d[\d,]*(?:\.\d+)?", match.group(0))[0])), "percent"
        ),
    )
    add(
        _SCALAR_RE,
        lambda match: NumberToken(
            match.group(0).rstrip(","),
            "scalar",
            _decimal_string(_decimal(re.findall(r"[-+]?\d[\d,]*(?:\.\d+)?", match.group(0))[0])),
            "multiple" if "倍" in match.group(0) else "scalar",
        ),
    )
    return [item[2] for item in sorted(found, key=lambda item: item[0])]


def _gold_token(item: Dict[str, Any]) -> NumberToken:
    canonical = item["canonical"]
    unit = str(canonical["unit"])
    value = str(canonical["value"])
    verbatim_tokens = extract_numbers(str(item["verbatim"]))
    if verbatim_tokens:
        parsed = verbatim_tokens[0]
        if canonical.get("derived") or unit in {"CNY", "USD", "HKD", "date", "doc_no", "percent"}:
            normalized = _normalize_doc(value) if unit == "doc_no" else value
            return NumberToken(
                raw=str(item["verbatim"]),
                kind=parsed.kind,
                value=normalized,
                unit=unit,
                numeric_raw=parsed.numeric_raw,
                multiplier=parsed.multiplier,
            )
        return parsed
    normalized = _normalize_doc(value) if unit == "doc_no" else value
    return NumberToken(str(item["verbatim"]), unit, normalized, unit)


def _ratio_percent_bridge(a: NumberToken, b: NumberToken):
    """0.8167(ratio)与 81.67%(percent)是同一量——返回换算到同尺度的浮点对,不可换算返回 None。"""
    pair = {a.unit, b.unit}
    if pair != {"ratio", "percent"}:
        return None
    try:
        va, vb = float(a.value), float(b.value)
    except (TypeError, ValueError):
        return None
    if a.unit == "percent":
        va = va / 100.0
    if b.unit == "percent":
        vb = vb / 100.0
    return va, vb


def _is_match(output: NumberToken, gold: NumberToken) -> bool:
    if output.unit != gold.unit:
        bridged = _ratio_percent_bridge(output, gold)
        if bridged is None:
            return False
        return abs(bridged[0] - bridged[1]) <= 1e-12
    if output.unit == "doc_no":
        return _normalize_doc(output.value) == _normalize_doc(gold.value)
    return output.value == gold.value


def _is_tolerant_derived_match(token: "NumberToken", gold: "NumberToken") -> bool:
    """gold 标 derived=true 的衍生数(如「约 81.7%」)允许 0.5% 相对误差——
    金标准 notes 已声明区间容忍,精确匹配会把算得更准的答案判为编造(狗粮实测踩到)。"""
    bridged = _ratio_percent_bridge(token, gold)
    if bridged is not None:
        a, b = bridged
    else:
        try:
            a = float(token.value)
            b = float(gold.value)
        except (TypeError, ValueError):
            return False
    if b == 0:
        return a == 0
    return abs(a - b) / abs(b) <= 0.005 + 1e-9


def _is_unit_mismatch(output: NumberToken, gold: NumberToken) -> bool:
    if output.kind != "amount" or gold.kind != "amount":
        return False
    if output.numeric_raw == gold.numeric_raw and (output.multiplier != gold.multiplier or output.unit != gold.unit):
        return True
    return output.value == gold.value and output.unit != gold.unit


_UNIT_DECL_RE = re.compile(
    r"[单單]位[:：]\s*(?:人民[币幣])?\s*(万亿元|萬億元|亿元|億元|万元|萬元|千元|元)"
)


def _declared_unit_multipliers(source_text: str):
    """Table-level unit declarations (单位：万元) that license bare source scalars.

    A filing table prints "330,151.30" under a 单位：万元 header; an answer that
    writes "330,151.30 万元" states the same quantity. Mirrors the per-claim
    unit-window rule the agent-side verifier applies (its P1-5 review fix) —
    without this the bench flags correctly-united restatements as fabricated.
    """
    found = []
    for match in _UNIT_DECL_RE.finditer(source_text):
        label = match.group(1).translate(_TRADITIONAL_UNIT_CHARS)
        if label in _UNIT_MAP:
            pair = _UNIT_MAP[label]
            if pair not in found:
                found.append(pair)
    return found


def score_number_fidelity(
    output: str,
    gold_numbers: Iterable[Dict[str, Any]],
    source_text: str = "",
) -> Dict[str, Any]:
    output_tokens = extract_numbers(output)
    gold_items = list(gold_numbers)
    gold_tokens = [_gold_token(item) for item in gold_items]
    derived_tokens = [
        tok for tok, item in zip(gold_tokens, gold_items)
        if (item.get("canonical") or {}).get("derived")
    ]
    source_tokens = extract_numbers(source_text)
    declared_units = _declared_unit_multipliers(source_text)
    matches: List[Dict[str, Any]] = []
    derivable: List[Dict[str, Any]] = []
    violations: List[Dict[str, Any]] = []

    for token in output_tokens:
        matching = next((gold for gold in gold_tokens if _is_match(token, gold)), None)
        if matching is None:
            matching = next(
                (gold for gold in derived_tokens if _is_tolerant_derived_match(token, gold)), None
            )
        if matching is not None:
            matches.append({"output": asdict(token), "gold": asdict(matching)})
            continue
        source_match = next((source for source in source_tokens if _is_match(token, source)), None)
        if source_match is not None:
            derivable.append({"output": asdict(token), "source": asdict(source_match)})
            continue
        if token.kind == "amount":
            hinted = None
            for unit, multiplier in declared_units:
                if token.unit != unit:
                    continue
                for source in source_tokens:
                    if source.kind != "scalar":
                        continue
                    try:
                        if Decimal(source.value) * multiplier == Decimal(token.value):
                            hinted = source
                            break
                    except (ArithmeticError, ValueError):
                        continue
                if hinted is not None:
                    break
            if hinted is not None:
                derivable.append({"output": asdict(token), "source": asdict(hinted), "via": "declared_unit"})
                continue
        if token.kind == "scalar" and token.value.isdigit() and 1900 <= int(token.value) <= 2100:
            # A bare year the source itself carries (inside any date or as a
            # bare figure) is period context, not an invented label.
            year = token.value
            in_source = any(
                (source.kind == "date" and source.value.startswith(year))
                or (source.kind == "scalar" and source.value == year)
                for source in source_tokens
            )
            if in_source:
                derivable.append({"output": asdict(token), "source": None, "via": "source_year"})
            else:
                violations.append({"kind": "unlisted_structural_year", "output": asdict(token), "near_gold": None})
            continue
        unit_mismatch = next(
            (gold for gold in [*gold_tokens, *source_tokens] if _is_unit_mismatch(token, gold)), None
        )
        kind = "unit_mismatch" if unit_mismatch is not None else "fabricated_or_not_derivable"
        violations.append(
            {
                "kind": kind,
                "output": asdict(token),
                "near_gold": asdict(unit_mismatch) if unit_mismatch is not None else None,
            }
        )

    if not output_tokens:
        score = 1.0
    else:
        weighted_errors = sum(
            2 if item["kind"] == "unit_mismatch" else 0 if item["kind"] == "unlisted_structural_year" else 1
            for item in violations
        )
        valid = len(matches) + len(derivable)
        score = valid / (valid + weighted_errors) if valid or weighted_errors else 1.0
        # A bare period label is recorded as an error but carries less weight
        # than a fabricated financial value. Dates explicitly authored in gold
        # are compound date tokens and receive normal matching behavior.
        distinct_unlisted_years = {
            item["output"]["value"] for item in violations if item["kind"] == "unlisted_structural_year"
        }
        score = max(0.0, score - 0.1 * len(distinct_unlisted_years))
        if any(item["kind"] == "unit_mismatch" for item in violations):
            score = min(score, 0.5)
    return {
        "score": round(score, 6),
        "extracted": [asdict(item) for item in output_tokens],
        "matches": matches,
        "derivable": derivable,
        "violations": violations,
    }
