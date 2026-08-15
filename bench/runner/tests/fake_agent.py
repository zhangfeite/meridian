#!/usr/bin/env python3
import json
import sys


request = json.load(sys.stdin)
print(json.dumps({"output": "fake response for " + request["task_id"]}, ensure_ascii=False))

