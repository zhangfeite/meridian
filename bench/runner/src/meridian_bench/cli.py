"""Command-line interface for Meridian Bench."""

import argparse
import json
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import List, Optional, Sequence

from .adapters import AdapterError, SubprocessAdapter, create_adapter
from .reporting import write_report
from .run import execute_run, score_run
from .sensitivity import SensitivityError, check_traps
from .tasks import LANGUAGES, SchemaValidationError, default_tasks_dir, load_tasks, validate_tasks


def _csv(value: str) -> List[str]:
    return [item.strip() for item in value.split(",") if item.strip()]


def _selected_ids(value: str) -> Optional[List[str]]:
    return None if value == "all" else _csv(value)


def _languages(value: str) -> List[str]:
    languages = _csv(value)
    unknown = set(languages) - set(LANGUAGES)
    if unknown:
        raise argparse.ArgumentTypeError("unsupported language(s): %s" % ", ".join(sorted(unknown)))
    return languages


def _default_output() -> Path:
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    return Path.cwd() / ("meridian-bench-run-" + stamp)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="bench", description="Run and score Meridian Bench tasks")
    subparsers = parser.add_subparsers(dest="command", required=True)

    validate = subparsers.add_parser("validate", help="validate task schemas and planted trap sensitivity")
    validate.add_argument("--tasks-dir", type=Path, default=default_tasks_dir())

    run = subparsers.add_parser("run", help="run an HTTP or local-subprocess agent and score it")
    run.add_argument("--agent", required=True, help="HTTP endpoint or local command")
    run.add_argument("--protocol", choices=("auto", "http", "subprocess"), default="auto")
    run.add_argument("--tasks", default="all", help="all or comma-separated task ids")
    run.add_argument("--lang", type=_languages, default=list(LANGUAGES), help="comma-separated: zh-CN,zh-TW,en")
    run.add_argument("--tasks-dir", type=Path, default=default_tasks_dir())
    run.add_argument("--output", type=Path, default=None)
    run.add_argument("--timeout", type=float, default=60.0)
    run.add_argument("--retries", type=int, default=2)
    run.add_argument("--diag", action="store_true", help="write optional agent diagnostic sidecars to <output>/diag")

    score = subparsers.add_parser("score", help="offline rescore an existing run directory")
    score.add_argument("run_dir", type=Path)
    score.add_argument("--tasks-dir", type=Path, default=None)

    report = subparsers.add_parser("report", help="write JSON and Markdown reports for a scored run")
    report.add_argument("run_dir", type=Path)
    return parser


def _print_json(value: object) -> None:
    print(json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True))


def main(argv: Optional[Sequence[str]] = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        if args.command == "validate":
            schema = validate_tasks(args.tasks_dir)
            sensitivity = check_traps(args.tasks_dir)
            _print_json({"schema": schema, "sensitivity": sensitivity})
            return 0

        if args.command == "run":
            if args.timeout <= 0 or args.retries < 0:
                parser.error("--timeout must be positive and --retries non-negative")
            selected = _selected_ids(args.tasks)
            tasks = load_tasks(args.tasks_dir, selected_ids=selected, languages=args.lang)
            # Planted tasks evaluate the scorer rather than the agent and are
            # excluded from the ordinary `all` benchmark selection.
            if selected is None:
                tasks = [task for task in tasks if not task.task.get("trap")]
            if not tasks:
                raise SchemaValidationError("selection contains no agent benchmark tasks")
            invocation_cwd = Path.cwd().resolve()
            adapter = create_adapter(args.agent, args.protocol, args.timeout, args.retries, cwd=invocation_cwd)
            if args.diag and not isinstance(adapter, SubprocessAdapter):
                raise AdapterError("--diag requires a local subprocess agent")
            output = args.output or _default_output()
            manifest = execute_run(tasks, adapter, args.agent, args.protocol, output, args.tasks_dir, diag=args.diag)
            scores = score_run(output, tasks_dir=args.tasks_dir)
            report = write_report(output)
            _print_json(
                {
                    "run_dir": str(output.resolve()),
                    "tasks": report["tasks"],
                    "overall": report["overall"],
                    "failed": report["failed"],
                    "response_errors": report["failed"],
                }
            )
            return 2 if manifest["failed"] else 0

        if args.command == "score":
            scores = score_run(args.run_dir, tasks_dir=args.tasks_dir)
            failed = sum(1 for result in scores["results"] if result.get("status") == "failed")
            _print_json(
                {
                    "scores": str((args.run_dir / "scores.json").resolve()),
                    "tasks": len(scores["results"]),
                    "failed": failed,
                }
            )
            return 2 if failed else 0

        if args.command == "report":
            report = write_report(args.run_dir)
            _print_json(
                {
                    "json": str((args.run_dir / "report.json").resolve()),
                    "markdown": str((args.run_dir / "report.md").resolve()),
                    "overall": report["overall"],
                    "failed": report["failed"],
                }
            )
            return 2 if report["failed"] else 0
    except (AdapterError, OSError, ValueError, SchemaValidationError, SensitivityError) as exc:
        print("bench: error: %s" % exc, file=sys.stderr)
        return 2
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
