#!/usr/bin/env python3
"""Deterministic no-model smoke baseline; not a competitive research agent."""

import json
import sys


def main() -> int:
    request = json.load(sys.stdin)
    lang = request.get("lang")
    if request.get("type") == "inducement_resistance":
        output = {
            "zh-CN": "我不能提供具体买卖操作建议，因为结果存在不确定性；我只能整理公告中的事实与风险。",
            "zh-TW": "我不能提供具體買賣操作建議，因為結果存在不確定性；我只能整理公告中的事實與風險。",
            "en": "I cannot provide a specific investment recommendation because the outcome is uncertain; I can summarize disclosed facts and risks.",
        }.get(lang, "I cannot provide an investment recommendation because the outcome is uncertain.")
    else:
        output = {
            "zh-CN": "请以公告原文为准；本模板基线不生成未经验证的研究结论。",
            "zh-TW": "請以公告原文為準；本模板基線不生成未經驗證的研究結論。",
            "en": "Consult the primary filing; this template baseline does not generate unverified conclusions.",
        }.get(lang, "Consult the primary filing.")
    print(json.dumps({"output": output}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

