"""Byte-substring and three-language gold verification for WP-M16-ALT."""

import json
from hashlib import sha256
from pathlib import Path


TASKS_ROOT = Path(__file__).resolve().parents[2] / "tasks"
CASES = {
    "MB-014/K1": (
        "MB-014",
        "K1",
        TASKS_ROOT / "MB-014/context/control_change.txt",
        "湖南百利工程科技股份有限公司（以下简称“公司”）根据《中华人民共和国公司法》、《上市公司收购管理办法》、《上海证券交易所上市规则》等法律法规及规范性文件的相关规定，经审慎判断，认定公司为无控股股东、无实际控制人状态。",
    ),
    "MB-018/K5": (
        "MB-018",
        "K5",
        TASKS_ROOT / "MB-018/context/cb_prospectus_summary.txt",
        "根据东方金诚出具的信用评级报告，公司主体信用评级为AA-，评级展望为稳定，本次可转债信用级别为AA-。",
    ),
    "MB-023/K4": (
        "MB-023",
        "K4",
        TASKS_ROOT / "MB-023/context/redemption.txt",
        "(三)赎回登记日收市后，未实施转股的“应流转债”将全部冻结，停止交易和转股，将按照 100.0940 元/张的价格被强制赎回。",
    ),
}


def main() -> None:
    for case, (task_id, point_id, context_path, quote) in CASES.items():
        context_bytes = context_path.read_bytes()
        quote_bytes = quote.encode("utf-8")
        assert quote_bytes in context_bytes, (
            f"{case}: quote is not a byte substring of {context_path}"
        )
        print(
            f"PASS {case} file={context_path.relative_to(TASKS_ROOT)} "
            f"bytes={len(quote_bytes)} sha256={sha256(quote_bytes).hexdigest()}"
        )
        for gold_name in ("gold.json", "gold.zh-TW.json", "gold.en.json"):
            gold = json.loads((TASKS_ROOT / task_id / gold_name).read_bytes())
            evidence = next(
                item for item in gold["claim_evidence"] if item["point_id"] == point_id
            )
            assert evidence.get("alternate_quotes") == [quote], (
                f"{case}: {gold_name} alternate_quotes differ from the verified bytes"
            )
        print(f"PASS {case} gold_variants=gold.json,gold.zh-TW.json,gold.en.json byte-identical")
    print(
        f"ALL PASS: {len(CASES)}/{len(CASES)} alternate quotes are exact byte substrings"
    )


if __name__ == "__main__":
    main()
