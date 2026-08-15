"""HTTP and local-subprocess protocols for agents under test."""

import json
import shlex
import shutil
import subprocess
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, Optional


class AdapterError(RuntimeError):
    pass


@dataclass(frozen=True)
class AdapterResult:
    output: str
    attempts: int


def _extract_text(payload: Any) -> str:
    if isinstance(payload, str):
        return payload
    if isinstance(payload, dict):
        for key in ("output", "text", "response"):
            if isinstance(payload.get(key), str):
                return payload[key]
        choices = payload.get("choices")
        if isinstance(choices, list) and choices:
            first = choices[0]
            if isinstance(first, dict):
                message = first.get("message")
                if isinstance(message, dict) and isinstance(message.get("content"), str):
                    return message["content"]
    raise AdapterError("agent response must be text or JSON containing output/text/response")


class AgentAdapter:
    def run(self, request_payload: Dict[str, Any]) -> AdapterResult:
        raise NotImplementedError


class HttpAdapter(AgentAdapter):
    def __init__(self, endpoint: str, timeout: float = 60.0, retries: int = 2) -> None:
        self.endpoint = endpoint
        self.timeout = timeout
        self.retries = retries

    def run(self, request_payload: Dict[str, Any]) -> AdapterResult:
        body = json.dumps(request_payload, ensure_ascii=False).encode("utf-8")
        last_error: Optional[BaseException] = None
        for attempt in range(1, self.retries + 2):
            request = urllib.request.Request(
                self.endpoint,
                data=body,
                headers={"Content-Type": "application/json", "Accept": "application/json, text/plain"},
                method="POST",
            )
            try:
                with urllib.request.urlopen(request, timeout=self.timeout) as response:
                    raw = response.read().decode("utf-8")
                    try:
                        parsed: Any = json.loads(raw)
                    except json.JSONDecodeError:
                        parsed = raw
                    return AdapterResult(_extract_text(parsed), attempt)
            except (OSError, urllib.error.URLError, urllib.error.HTTPError, UnicodeError, AdapterError) as exc:
                last_error = exc
                if attempt <= self.retries:
                    time.sleep(min(0.25 * attempt, 1.0))
        raise AdapterError("HTTP agent failed after %d attempt(s): %s" % (self.retries + 1, last_error))


class SubprocessAdapter(AgentAdapter):
    def __init__(
        self,
        command: str,
        timeout: float = 60.0,
        retries: int = 2,
        cwd: Optional[Path] = None,
    ) -> None:
        self.command = shlex.split(command)
        if not self.command:
            raise AdapterError("subprocess command is empty")
        self.timeout = timeout
        self.retries = retries
        # Capture the caller's directory once. Package installation or `uv run
        # --project` must not make relative agent paths depend on runner internals.
        self.cwd = (cwd or Path.cwd()).resolve()

    def _command_context(self) -> str:
        executable = self.command[0]
        if Path(executable).is_absolute() or "/" in executable:
            resolved_executable = str((self.cwd / executable).resolve()) if not Path(executable).is_absolute() else executable
        else:
            resolved_executable = shutil.which(executable) or executable
        relative_paths = []
        for argument in self.command[1:]:
            candidate = Path(argument)
            if argument.startswith("-") or candidate.is_absolute():
                continue
            if "/" in argument or candidate.suffix:
                relative_paths.append("%s -> %s" % (argument, (self.cwd / candidate).resolve()))
        details = "cwd=%s, executable=%s" % (self.cwd, resolved_executable)
        if relative_paths:
            details += ", resolved_paths=[%s]" % ", ".join(relative_paths)
        return details

    def run(self, request_payload: Dict[str, Any]) -> AdapterResult:
        stdin = json.dumps(request_payload, ensure_ascii=False)
        last_error: Optional[BaseException] = None
        for attempt in range(1, self.retries + 2):
            try:
                completed = subprocess.run(
                    self.command,
                    input=stdin,
                    capture_output=True,
                    text=True,
                    timeout=self.timeout,
                    check=False,
                    cwd=self.cwd,
                )
                if completed.returncode != 0:
                    raise AdapterError(
                        "command exited %d (%s): %s"
                        % (completed.returncode, self._command_context(), completed.stderr.strip() or "no stderr")
                    )
                raw = completed.stdout.strip()
                try:
                    parsed: Any = json.loads(raw)
                except json.JSONDecodeError:
                    parsed = raw
                return AdapterResult(_extract_text(parsed), attempt)
            except (OSError, subprocess.TimeoutExpired, UnicodeError, AdapterError) as exc:
                last_error = exc
                if attempt <= self.retries:
                    time.sleep(min(0.25 * attempt, 1.0))
        raise AdapterError(
            "subprocess agent failed after %d attempt(s) (%s): %s"
            % (self.retries + 1, self._command_context(), last_error)
        )


def create_adapter(
    agent: str,
    protocol: str,
    timeout: float,
    retries: int,
    cwd: Optional[Path] = None,
) -> AgentAdapter:
    selected = protocol
    if protocol == "auto":
        selected = "http" if agent.startswith(("http://", "https://")) else "subprocess"
    if selected == "http":
        return HttpAdapter(agent, timeout=timeout, retries=retries)
    if selected == "subprocess":
        return SubprocessAdapter(agent, timeout=timeout, retries=retries, cwd=cwd)
    raise AdapterError("unsupported protocol: %s" % protocol)
