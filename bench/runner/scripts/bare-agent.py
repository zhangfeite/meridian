#!/usr/bin/env python3
"""Meridian Bench bare-model subprocess agent for DeepSeek Chat."""

import json
import os
import sys
import time
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen


API_URL = "https://api.deepseek.com/chat/completions"
MAX_RETRIES = 2


class AgentError(Exception):
    """An input or API response error that should be reported to the runner."""


def read_task() -> dict[str, Any]:
    """Read one task object from standard input."""
    try:
        task = json.load(sys.stdin)
    except json.JSONDecodeError as error:
        raise AgentError(f"invalid input JSON: {error}") from error
    if not isinstance(task, dict):
        raise AgentError("input JSON must be an object")
    if not isinstance(task.get("prompt"), str):
        raise AgentError("input JSON must contain a string prompt field")
    return task


def request_completion(prompt: str, api_key: str) -> str:
    """Send *prompt* unchanged as the sole DeepSeek chat message and return text."""
    payload = json.dumps(
        {
            "model": "deepseek-chat",
            "temperature": 0,
            "messages": [{"role": "user", "content": prompt}],
        },
        ensure_ascii=False,
    ).encode("utf-8")
    request = Request(
        API_URL,
        data=payload,
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        },
        method="POST",
    )

    for attempt in range(MAX_RETRIES + 1):
        try:
            with urlopen(request, timeout=60) as response:
                body = json.load(response)
            content = body["choices"][0]["message"]["content"]
            if not isinstance(content, str):
                raise AgentError("DeepSeek response content was not text")
            return content
        except HTTPError as error:
            # Rate limits and server errors are transient; other API rejections
            # (for example, an invalid key) are useful immediately.
            retryable = error.code == 429 or error.code >= 500
            message = f"DeepSeek API HTTP {error.code}: {error.reason}"
        except URLError as error:
            retryable = True
            message = f"DeepSeek network error: {error.reason}"
        except TimeoutError as error:
            retryable = True
            message = f"DeepSeek network timeout: {error}"
        except (KeyError, IndexError, TypeError, json.JSONDecodeError) as error:
            raise AgentError(f"invalid DeepSeek response: {error}") from error

        if not retryable or attempt == MAX_RETRIES:
            raise AgentError(message)
        time.sleep(0.25 * (attempt + 1))

    raise AssertionError("unreachable")


def main() -> int:
    try:
        task = read_task()
        api_key = os.environ.get("DEEPSEEK_API_KEY")
        if not api_key:
            raise AgentError("DEEPSEEK_API_KEY is not set")
        sys.stdout.write(request_completion(task["prompt"], api_key))
        return 0
    except AgentError as error:
        print(f"bare-agent: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
