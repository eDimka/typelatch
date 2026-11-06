#!/usr/bin/env python3
"""Render the illustrated terminal walkthrough from site/demo.json with Pillow."""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent.parent
WIDTH, HEIGHT = 1080, 760
COLORS = {
    "paper": "#f4f1e8",
    "ink": "#19171c",
    "muted": "#69656e",
    "line": "#d9d4ca",
    "terminal": "#19171c",
    "terminal_header": "#25222b",
    "terminal_line": "#49434f",
    "text": "#f4f1e8",
    "soft": "#bbb4c6",
    "coral": "#ff7759",
    "lilac": "#c7b5ed",
    "lime": "#d9ee9e",
}


def font_path(role: str, explicit: str | None) -> str:
    if explicit:
        path = Path(explicit).expanduser()
        if not path.is_file():
            raise FileNotFoundError(path)
        return str(path)
    candidates = {
        "sans": [
            "/System/Library/Fonts/SFNS.ttf",
            "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
            "/usr/share/fonts/truetype/liberation2/LiberationSans-Regular.ttf",
        ],
        "mono": [
            "/System/Library/Fonts/SFNSMono.ttf",
            "/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf",
            "/usr/share/fonts/truetype/liberation2/LiberationMono-Regular.ttf",
        ],
    }
    for candidate in candidates[role]:
        if Path(candidate).is_file():
            return candidate
    raise RuntimeError(f"Pass --{role}-font with an installed TrueType or OpenType font")


def wrap(text: str, font: ImageFont.FreeTypeFont, width: int, indent: str = "  ") -> list[str]:
    """Preserve explicit source lines and wrap visually without losing characters."""
    output = []
    for line in text.split("\n"):
        if not line:
            output.append("")
            continue
        remaining = line
        continuation = ""
        while font.getlength(continuation + remaining) > width:
            cut = len(remaining)
            while cut > 1 and font.getlength(continuation + remaining[:cut]) > width:
                cut -= 1
            space = remaining.rfind(" ", 0, cut)
            if space > cut // 2:
                cut = space + 1
            output.append(continuation + remaining[:cut])
            remaining = remaining[cut:]
            continuation = indent
        output.append(continuation + remaining)
    return output


def text(draw, xy, value, font, color):
    draw.text(xy, value, font=font, fill=COLORS.get(color, color), anchor="lt")


def line_color(line: str) -> str:
    stripped = line.strip()
    if stripped.startswith("not ok") or stripped == "# fail 1":
        return "coral"
    if stripped.startswith("ok ") or "pass" in stripped or stripped.startswith("→"):
        return "lime"
    if stripped.startswith("#") or stripped.startswith("Coverage"):
        return "soft"
    if stripped.startswith("$") or stripped.startswith("workspace_") or stripped.startswith("library_"):
        return "lilac"
    return "text"


def make_frame(scene, scene_index, scenes, visible_code, fonts, disclosure, completed=False):
    frame = Image.new("RGB", (WIDTH, HEIGHT), COLORS["paper"])
    draw = ImageDraw.Draw(frame)

    text(draw, (36, 27), "typelatch", fonts["brand"], "ink")
    dot_offset = fonts["brand"].getbbox(".")[1] - fonts["brand"].getbbox("typelatch")[1]
    text(draw, (36 + fonts["brand"].getlength("typelatch"), 27 + dot_offset), ".", fonts["brand"], "coral")
    badge_width = math.ceil(fonts["small"].getlength(disclosure)) + 30
    draw.rounded_rectangle((1044 - badge_width, 23, 1044, 58), radius=17, fill=COLORS["lilac"])
    text(draw, (1059 - badge_width, 30), disclosure, fonts["small"], "ink")

    text(draw, (36, 88), scene["title"], fonts["title"], "ink")
    body_lines = wrap(scene["body"], fonts["body"], 990, indent="")
    if len(body_lines) > 2:
        raise ValueError(f"Body needs more than two lines: {scene['id']}")
    for i, line in enumerate(body_lines):
        text(draw, (38, 145 + i * 28), line, fonts["body"], "muted")

    draw.rounded_rectangle((36, 214, 1044, 601), radius=18, fill=COLORS["terminal"])
    draw.rounded_rectangle((36, 214, 1044, 263), radius=18, fill=COLORS["terminal_header"])
    draw.rectangle((36, 242, 1044, 263), fill=COLORS["terminal_header"])
    for i, color in enumerate(["coral", "lilac", "lime"]):
        draw.ellipse((57 + i * 22, 233, 67 + i * 22, 243), fill=COLORS[color])
    text(draw, (143, 228), scene["eyebrow"].lower(), fonts["small"], "soft")
    right = "setup instructions" if scene["kind"] == "instructions" else "recorded evidence"
    text(draw, (1018 - fonts["small"].getlength(right), 228), right, fonts["small"], "soft")

    code_lines = wrap(visible_code, fonts["mono"], 948)
    if len(code_lines) > 10:
        raise ValueError(f"Code exceeds ten lines: {scene['id']} ({len(code_lines)})")
    for i, line in enumerate(code_lines):
        text(draw, (62, 280 + i * 30), line, fonts["mono"], line_color(line))

    # A still cursor marks progression without introducing a flashing loop.
    if visible_code and visible_code != scene["code"]:
        last = code_lines[-1]
        cursor_x = 63 + fonts["mono"].getlength(last)
        if cursor_x < 1018:
            y = 280 + (len(code_lines) - 1) * 30
            draw.rectangle((cursor_x, y + 2, cursor_x + 10, y + 23), fill=COLORS["lilac"])

    caption_lines = wrap(scene["caption"], fonts["small"], 1006, indent="")
    if len(caption_lines) > 2:
        raise ValueError(f"Caption exceeds two lines: {scene['id']}")
    for i, line in enumerate(caption_lines):
        text(draw, (38, 619 + i * 26), line, fonts["small"], "muted")

    step_width = 1008 / len(scenes)
    for i, item in enumerate(scenes):
        left = 36 + i * step_width
        active = i == scene_index
        done = i < scene_index or completed
        color = "ink" if active else "line"
        if done:
            color = "lilac"
        draw.rounded_rectangle((left, 696, left + step_width - 10, 702), radius=3, fill=COLORS[color])
        text(draw, (left, 716), item["eyebrow"].lower(), fonts["rail"], "ink" if active or done else "muted")

    return frame


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", type=Path, default=ROOT / "site/demo.json")
    parser.add_argument("--output", type=Path, default=ROOT / "site/assets")
    parser.add_argument("--sans-font")
    parser.add_argument("--mono-font")
    parser.add_argument("--proofs", type=Path, help="Optional output directory for one PNG per scene")
    args = parser.parse_args()
    sans = font_path("sans", args.sans_font or os.environ.get("TYPELATCH_DEMO_SANS"))
    mono = font_path("mono", args.mono_font or os.environ.get("TYPELATCH_DEMO_MONO"))
    fonts = {
        "brand": ImageFont.truetype(sans, 29),
        "title": ImageFont.truetype(sans, 43),
        "body": ImageFont.truetype(sans, 24),
        "small": ImageFont.truetype(sans, 22),
        "mono": ImageFont.truetype(mono, 22),
        "rail": ImageFont.truetype(sans, 22),
    }
    source = args.input.read_bytes()
    data = json.loads(source)
    scenes = data["scenes"]
    if not scenes:
        raise ValueError("At least one scene is required")
    disclosure = data.get("animationLabel", "Illustrated MCP replay")
    frames = []
    durations = []
    full_frames = []
    for index, scene in enumerate(scenes):
        code = scene["code"]
        full = make_frame(scene, index, scenes, code, fonts, disclosure)
        full_frames.append(full)
        if args.proofs:
            args.proofs.mkdir(parents=True, exist_ok=True)
            full.save(args.proofs / f"{index + 1:02d}-{scene['id']}.png")
        # Keep the first command legible from the first frame, then reveal the response.
        initial = code.find("\n")
        initial = len(code) if initial < 0 else initial
        duration = int(scene.get("durationMs", 4500))
        animation_ms = min(1400, duration // 3)
        steps = 10
        for step in range(steps):
            count = initial + math.ceil((len(code) - initial) * step / (steps - 1))
            frames.append(make_frame(scene, index, scenes, code[:count], fonts, disclosure))
            durations.append(animation_ms // steps)
        durations[-1] += duration - sum(durations[-steps:])

    args.output.mkdir(parents=True, exist_ok=True)
    poster = args.output / "zero-to-hero.png"
    gif = args.output / "zero-to-hero.gif"
    make_frame(scenes[-1], len(scenes) - 1, scenes, scenes[-1]["code"], fonts, disclosure, completed=True).save(poster, optimize=True)

    # Quantize every frame against one palette to keep text and colors stable.
    palette_source = Image.new("RGB", (WIDTH, HEIGHT * len(full_frames)))
    for index, frame in enumerate(full_frames):
        palette_source.paste(frame, (0, HEIGHT * index))
    palette = palette_source.quantize(colors=96, method=Image.Quantize.MEDIANCUT)
    indexed = [frame.quantize(palette=palette, dither=Image.Dither.NONE) for frame in frames]
    indexed[0].save(gif, save_all=True, append_images=indexed[1:], duration=durations,
                    loop=0, optimize=True, disposal=1,
                    comment=("Typelatch illustrated walkthrough. " + data["disclosure"]).encode("utf-8"))
    print(json.dumps({
        "input": str(args.input),
        "inputSha256": hashlib.sha256(source).hexdigest(),
        "gif": str(gif),
        "gifBytes": gif.stat().st_size,
        "poster": str(poster),
        "posterBytes": poster.stat().st_size,
        "width": WIDTH,
        "height": HEIGHT,
        "durationMs": sum(durations),
        "frames": len(frames),
        "fonts": {"sans": sans, "mono": mono},
    }, indent=2))


if __name__ == "__main__":
    main()
