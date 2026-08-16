#!/usr/bin/env python3
import json
import os
import sys
from pathlib import Path


request = json.load(sys.stdin)
diagnostic_dir = os.environ.get("MERIDIAN_DIAG_DIR")
if diagnostic_dir:
    target = Path(diagnostic_dir)
    target.mkdir(parents=True, exist_ok=True)
    (target / ("%s.%s.diag.json" % (request["task_id"], request["lang"]))).write_text(
        json.dumps(
            {
                "task_id": request["task_id"],
                "lang": request["lang"],
                "rejected": [],
                "notes": [],
                "spans": [],
                "audit": [],
            },
            ensure_ascii=False,
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )
print(json.dumps({"output": "fake response for " + request["task_id"]}, ensure_ascii=False))
