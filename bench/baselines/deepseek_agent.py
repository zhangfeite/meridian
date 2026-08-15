#!/usr/bin/env python3
"""Minimal DeepSeek chat-completions subprocess client for Meridian Bench."""

import json
import os
import sys
import urllib.request
from typing import Any, Dict


def main() -> int:
    request_payload: Dict[str, Any] = json.load(sys.stdin)
    endpoint = os.environ.get("DEEPSEEK_BASE_URL", "https://api.deepseek.com/chat/completions")
    api_key = os.environ.get("DEEPSEEK_API_KEY", "")
    if not api_key:
        print("DEEPSEEK_API_KEY is required", file=sys.stderr)
        return 2
    body = json.dumps(
        {
            "model": os.environ.get("DEEPSEEK_MODEL", "deepseek-chat"),
            "messages": [{"role": "user", "content": request_payload["prompt"]}],
            "temperature": 0,
            "stream": False,
        },
        ensure_ascii=False,
    ).encode("utf-8")
    request = urllib.request.Request(
        endpoint,
        data=body,
        headers={"Authorization": "Bearer " + api_key, "Content-Type": "application/json"},
        method="POST",
    )
    timeout = float(os.environ.get("DEEPSEEK_TIMEOUT", "120"))
    with urllib.request.urlopen(request, timeout=timeout) as response:
        payload = json.loads(response.read().decode("utf-8"))
    print(json.dumps({"output": payload["choices"][0]["message"]["content"]}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

