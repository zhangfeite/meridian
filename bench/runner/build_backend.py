"""Tiny dependency-free PEP 517/660 backend for the standalone runner."""

import base64
import hashlib
import os
import tarfile
import zipfile
from pathlib import Path
from typing import Dict, Iterable, List, Optional, Tuple


NAME = "meridian_bench"
VERSION = "0.1.0"
DIST_INFO = "%s-%s.dist-info" % (NAME, VERSION)
WHEEL_NAME = "%s-%s-py3-none-any.whl" % (NAME, VERSION)
ROOT = Path(__file__).resolve().parent


def _metadata() -> bytes:
    return (
        "Metadata-Version: 2.1\n"
        "Name: meridian-bench\n"
        "Version: 0.1.0\n"
        "Summary: Deterministic, standalone runner for Meridian Bench\n"
        "Requires-Python: >=3.9\n"
        "License: MIT\n\n"
    ).encode("utf-8")


def _wheel() -> bytes:
    return (
        "Wheel-Version: 1.0\n"
        "Generator: meridian-bench-build-backend\n"
        "Root-Is-Purelib: true\n"
        "Tag: py3-none-any\n"
    ).encode("utf-8")


def _entry_points() -> bytes:
    return b"[console_scripts]\nbench = meridian_bench.cli:main\n"


def _digest(data: bytes) -> str:
    encoded = base64.urlsafe_b64encode(hashlib.sha256(data).digest()).rstrip(b"=").decode("ascii")
    return "sha256=" + encoded


def _write_wheel(wheel_directory: str, files: Iterable[Tuple[str, bytes]]) -> str:
    target = Path(wheel_directory) / WHEEL_NAME
    entries: List[Tuple[str, bytes]] = list(files)
    entries.extend(
        (
            (DIST_INFO + "/METADATA", _metadata()),
            (DIST_INFO + "/WHEEL", _wheel()),
            (DIST_INFO + "/entry_points.txt", _entry_points()),
        )
    )
    records = ["%s,%s,%d" % (name, _digest(data), len(data)) for name, data in entries]
    record_name = DIST_INFO + "/RECORD"
    records.append(record_name + ",,")
    entries.append((record_name, ("\n".join(records) + "\n").encode("utf-8")))
    with zipfile.ZipFile(str(target), "w", compression=zipfile.ZIP_DEFLATED) as archive:
        for name, data in entries:
            archive.writestr(name, data)
    return WHEEL_NAME


def get_requires_for_build_wheel(config_settings: Optional[Dict[str, object]] = None) -> List[str]:
    return []


def get_requires_for_build_editable(config_settings: Optional[Dict[str, object]] = None) -> List[str]:
    return []


def prepare_metadata_for_build_wheel(
    metadata_directory: str, config_settings: Optional[Dict[str, object]] = None
) -> str:
    directory = Path(metadata_directory) / DIST_INFO
    directory.mkdir(parents=True, exist_ok=True)
    (directory / "METADATA").write_bytes(_metadata())
    (directory / "WHEEL").write_bytes(_wheel())
    (directory / "entry_points.txt").write_bytes(_entry_points())
    return DIST_INFO


def build_wheel(
    wheel_directory: str,
    config_settings: Optional[Dict[str, object]] = None,
    metadata_directory: Optional[str] = None,
) -> str:
    package_root = ROOT / "src" / "meridian_bench"
    files = [
        (path.relative_to(ROOT / "src").as_posix(), path.read_bytes())
        for path in sorted(package_root.rglob("*.py"))
    ]
    return _write_wheel(wheel_directory, files)


def build_editable(
    wheel_directory: str,
    config_settings: Optional[Dict[str, object]] = None,
    metadata_directory: Optional[str] = None,
) -> str:
    path_file = (str((ROOT / "src").resolve()) + os.linesep).encode("utf-8")
    return _write_wheel(wheel_directory, [(NAME + ".pth", path_file)])


def build_sdist(sdist_directory: str, config_settings: Optional[Dict[str, object]] = None) -> str:
    filename = "meridian_bench-%s.tar.gz" % VERSION
    target = Path(sdist_directory) / filename
    prefix = "meridian_bench-%s" % VERSION
    selected = [ROOT / "pyproject.toml", ROOT / "build_backend.py", ROOT / "README.md"]
    selected.extend(sorted((ROOT / "src").rglob("*.py")))
    with tarfile.open(str(target), "w:gz") as archive:
        for path in selected:
            archive.add(str(path), arcname=prefix + "/" + path.relative_to(ROOT).as_posix())
    return filename
