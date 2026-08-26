#!/usr/bin/env python3
"""Compatibility wrapper for the dependency-free local PPTD exporter.

The historical script name is kept so existing agent instructions continue to
work.  Conversion itself is performed by the package's Node runtime and never
opens a browser.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import zipfile
import xml.etree.ElementTree as ET
from pathlib import Path


SCRIPT_ROOT = Path(__file__).resolve().parents[3]
PPTX_CONTENT_TYPE = "application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"
MIN_AGENT_BROWSER_VERSION = (0, 33, 2)
MIN_NODE_MAJOR = 18
ExportError = RuntimeError


def find_cli() -> Path:
    candidates = [
        SCRIPT_ROOT / "bin" / "open-kimi-ppt-skills.js",
        Path(__file__).resolve().parents[1] / "runtime" / "bin" / "open-kimi-ppt-skills.js",
    ]
    override = os.environ.get("OPEN_KIMI_PPT_CLI")
    if override:
        candidates.insert(0, Path(override).expanduser())
    for candidate in candidates:
        if candidate.is_file():
            return candidate
    executable = shutil.which("open-kimi-ppt-skills")
    if executable:
        return Path(executable)
    raise ExportError("local open-kimi-ppt runtime was not found; reinstall the skill")


def parse_version(output: str) -> tuple[int, int, int]:
    match = re.search(r"(\d+)\.(\d+)\.(\d+)\b", output)
    if not match:
        raise ExportError(f"could not parse version: {output.strip()}")
    return tuple(int(part) for part in match.groups())


def parse_node_version(output: str) -> tuple[int, int, int]:
    return parse_version(output)


def ensure_nodejs() -> str:
    executable = shutil.which("node")
    if not executable:
        raise ExportError("Node.js is not installed or not on PATH")
    result = subprocess.run([executable, "--version"], text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=30)
    version = parse_node_version(result.stdout)
    if version[0] < MIN_NODE_MAJOR:
        raise ExportError(f"Node.js {MIN_NODE_MAJOR}+ is required; found {version}")
    if not shutil.which("npm"):
        raise ExportError("npm is not installed or not on PATH")
    return executable


def ensure_agent_browser() -> str:
    """Legacy probe retained for callers that imported the old wrapper API."""
    ensure_nodejs()
    executable = shutil.which("agent-browser")
    if executable:
        result = subprocess.run([executable, "--version"], text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=30)
        if parse_version(result.stdout) >= MIN_AGENT_BROWSER_VERSION:
            return executable
    npm = shutil.which("npm")
    if not npm:
        raise ExportError("npm is required for the legacy browser probe")
    subprocess.run([npm, "install", "-g", "agent-browser@latest"], text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=300, check=True)
    executable = shutil.which("agent-browser")
    if not executable:
        raise ExportError("agent-browser was not found after installation")
    return executable


def root_child_names(slide_xml: bytes) -> list[str]:
    return [child.tag.rsplit("}", 1)[-1] for child in ET.fromstring(slide_xml)]


def replace_transition(slide_xml: bytes, transition: str) -> bytes:
    text = slide_xml.decode("utf-8")
    text = re.sub(r"<p:transition\b[^>]*(?:/>|>.*?</p:transition>)", "", text, flags=re.DOTALL)
    if transition == "none":
        return text.encode("utf-8")
    anchor = re.search(r"<p:clrMapOvr\b[^>]*(?:/>|>.*?</p:clrMapOvr>)", text, flags=re.DOTALL) or re.search(r"<p:cSld\b[^>]*(?:/>|>.*?</p:cSld>)", text, flags=re.DOTALL)
    if not anchor:
        raise ExportError("slide XML has no transition insertion anchor")
    return (text[:anchor.end()] + '<p:transition spd="fast" advClick="1"><p:fade/></p:transition>' + text[anchor.end():]).encode("utf-8")


def validate_transition_order(slide_xml: bytes, transition: str) -> None:
    names = root_child_names(slide_xml)
    indexes = [index for index, name in enumerate(names) if name == "transition"]
    if transition == "none":
        if indexes:
            raise ExportError("transition=none left a root-level transition")
        return
    if len(indexes) != 1 or b"<p:fade" not in slide_xml:
        raise ExportError("slide does not contain exactly one root-level fade transition")
    if "cSld" in names and names.index("cSld") > indexes[0]:
        raise ExportError("transition appears before cSld")
    if "timing" in names and names.index("timing") < indexes[0]:
        raise ExportError("transition appears after timing")


def patch_transitions(pptx: Path, transition: str) -> int:
    temporary = pptx.with_name(f".{pptx.name}.tmp")
    count = 0
    with zipfile.ZipFile(pptx) as source, zipfile.ZipFile(temporary, "w") as target:
        for item in source.infolist():
            data = source.read(item.filename)
            if re.fullmatch(r"ppt/slides/slide\d+\.xml", item.filename):
                data = replace_transition(data, transition); count += 1
            target.writestr(item, data)
    temporary.replace(pptx)
    return count


def run_local(source: Path, output: Path | None, transition: str, embed_fonts: str, force: bool) -> dict:
    command = ["node", str(find_cli()), "export", str(source), "--transition", transition, "--embed-fonts", embed_fonts]
    if output:
        command += ["--output", str(output)]
    if force:
        command.append("--force")
    process = subprocess.run(command, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if process.returncode:
        raise RuntimeError(process.stderr.strip() or process.stdout.strip() or "local export failed")
    try:
        return json.loads(process.stdout)
    except json.JSONDecodeError:
        return {"output": str(output) if output else None, "stdout": process.stdout.strip()}


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Export a PPTD project to PPTX locally")
    parser.add_argument("input", type=Path, help="PPTD manifest or project directory")
    parser.add_argument("--output", "-o", type=Path)
    parser.add_argument("--transition", choices=("fade", "none"), default="fade")
    font_group = parser.add_mutually_exclusive_group()
    font_group.add_argument("--embed-fonts", choices=("auto", "force", "none"), default="auto")
    font_group.add_argument("--no-embed-fonts", dest="embed_fonts", action="store_const", const="none", help="disable font embedding")
    parser.add_argument("--force", action="store_true")
    # Accepted by older versions; image embedding is now handled by the core.
    parser.add_argument("--keep-browser-raw", action="store_true", help=argparse.SUPPRESS)
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    try:
        result = run_local(args.input, args.output, args.transition, args.embed_fonts, args.force)
    except (OSError, RuntimeError) as exc:
        print(f"open-kimi-ppt export failed: {exc}", file=sys.stderr)
        return 1
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
