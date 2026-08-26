#!/usr/bin/env python3
"""Compatibility wrapper for local SVG/PNG rendering."""
from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import zipfile
from pathlib import Path


SCRIPT_ROOT = Path(__file__).resolve().parents[3]
OVERVIEW_THUMB_WIDTH = 320
OVERVIEW_LABEL_HEIGHT = 28
OVERVIEW_GAP = 16
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


def page_sort_key(path: Path):
    match = re.match(r"^(\d+)", path.stem)
    return (0, int(match.group(1))) if match else (1, path.name)


def is_image_zip(path: Path) -> bool:
    if not path.is_file():
        return False
    try:
        with zipfile.ZipFile(path) as archive:
            names = [name for name in archive.namelist() if not name.endswith("/")]
            return bool(names) and all(Path(name).suffix.lower() in {".png", ".jpg", ".jpeg", ".gif", ".webp"} for name in names)
    except zipfile.BadZipFile:
        return False


def unzip_images(archive_path: Path, output: Path) -> list[Path]:
    output.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(archive_path) as archive:
        names = sorted((Path(name) for name in archive.namelist() if Path(name).suffix.lower() in {".png", ".jpg", ".jpeg", ".gif", ".webp"}), key=page_sort_key)
        result = []
        for index, name in enumerate(names, 1):
            target = output / (name.name or f"{index}.png")
            target.write_bytes(archive.read(str(name)))
            result.append(target)
        return result


def ensure_pillow():
    try:
        from PIL import Image, ImageDraw, ImageFont
    except ImportError as exc:
        raise ExportError("Pillow is not installed; PNG rendering is handled by the local Node fallback") from exc
    try:
        font = ImageFont.load_default()
    except Exception:
        font = None
    return Image, ImageDraw, font


def stitch_overview(images: list[Path], output: Path, image_cls, draw_cls, image_font):
    if not images:
        raise ExportError("no images to stitch")
    columns = min(3, len(images)); rows = (len(images) + columns - 1) // columns
    cell_height = OVERVIEW_LABEL_HEIGHT + round(OVERVIEW_THUMB_WIDTH * 9 / 16)
    canvas = image_cls.new("RGB", (columns * OVERVIEW_THUMB_WIDTH + (columns + 1) * OVERVIEW_GAP, rows * cell_height + (rows + 1) * OVERVIEW_GAP), "#eef0f3")
    draw = draw_cls.Draw(canvas)
    for index, path in enumerate(images):
        row, column = divmod(index, columns); x = OVERVIEW_GAP + column * OVERVIEW_THUMB_WIDTH; y = OVERVIEW_GAP + row * cell_height
        with image_cls.open(path) as image:
            image.thumbnail((OVERVIEW_THUMB_WIDTH, cell_height - OVERVIEW_LABEL_HEIGHT)); canvas.paste(image.convert("RGB"), (x, y + OVERVIEW_LABEL_HEIGHT))
        draw.text((x, y + 5), str(index + 1), fill="#1f2937", font=image_font)
    canvas.save(output, "JPEG")
    return output


def run_local(source: Path, output: Path, image_format: str, scale: float, force: bool) -> dict:
    command = ["node", str(find_cli()), "render", str(source), "--output", str(output), "--format", image_format, "--scale", str(scale)]
    if force:
        command.append("--force")
    process = subprocess.run(command, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if process.returncode:
        raise RuntimeError(process.stderr.strip() or process.stdout.strip() or "local render failed")
    return json.loads(process.stdout)


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Render PPTD pages locally")
    parser.add_argument("input", type=Path)
    parser.add_argument("--output", "-o", type=Path)
    parser.add_argument("--format", choices=("png", "svg"), default="png")
    parser.add_argument("--scale", type=float, default=1)
    parser.add_argument("--force", action="store_true")
    parser.add_argument("--keep-browser-raw", action="store_true", help=argparse.SUPPRESS)
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    output = args.output or args.input.parent / ".qa-images"
    try:
        result = run_local(args.input, output, args.format, args.scale, args.force)
    except (OSError, RuntimeError, json.JSONDecodeError) as exc:
        print(f"open-kimi-ppt render failed: {exc}", file=sys.stderr)
        return 1
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
