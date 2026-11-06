#!/usr/bin/env python3
"""Render a public Codex action replay from the preregistered SQLite pair."""
import argparse
import hashlib
import json
import math
import re
import shlex
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

WIDTH, HEIGHT = 1080, 680
INK = '#19171c'
PAPER = '#f4f1e8'
MUTED = '#bcb6c3'
CORAL = '#ff7759'
LILAC = '#c7b5ed'
LIME = '#d9ee9e'
LINE = '#3c3742'
PANEL = '#211e26'
CARD = '#292530'
ROOT = Path(__file__).resolve().parent.parent
FONT_ROOT = ROOT / 'site/assets/fonts'
DURATION_MS = 32000
INTRO_MS, PLAY_MS, FINAL_MS = 2500, 24000, 5500
ARMS = ('baseline', 'typelatch')


def sha256(data):
    return hashlib.sha256(data).hexdigest()


def require(condition, message):
    if not condition:
        raise ValueError(message)


def font(size, mono=False):
    return ImageFont.truetype(str(FONT_ROOT / ('ibm-plex-mono-latin.woff2' if mono else 'archivo-latin.woff2')), size)


FONTS = {size: font(size) for size in (13, 14, 15, 16, 18, 22, 28, 36, 38)}
MONO = {size: font(size, True) for size in (12, 13, 14, 15, 16, 18, 22, 28)}


def clean(text):
    # Tool text is data. Remove terminal control sequences, never evaluate it.
    return re.sub(r'\s+', ' ', re.sub(r'\x1b\[[0-9;]*[A-Za-z]', '', str(text))).strip()


def short_path(path):
    value = clean(path)
    return value.removeprefix('$WORKSPACE/')


def shell_excerpt(command):
    value = str(command)
    try:
        words = shlex.split(value)
        if len(words) >= 3 and Path(words[0]).name in ('bash', 'zsh', 'sh') and re.fullmatch(r'-[a-zA-Z]*c[a-zA-Z]*', words[1]):
            value = words[2]
    except ValueError:
        pass
    return clean(value)


def text_lines(draw, text, selected_font, width, limit=2):
    text = clean(text)
    lines = []
    while text and len(lines) < limit:
        fit = 0
        for index in range(1, len(text) + 1):
            if draw.textlength(text[:index], font=selected_font) > width:
                break
            fit = index
        if fit == len(text):
            lines.append(text)
            text = ''
        elif fit == 0:
            break
        else:
            boundary = text.rfind(' ', 0, fit + 1)
            if boundary < fit // 2:
                boundary = fit
            lines.append(text[:boundary].rstrip())
            text = text[boundary:].lstrip()
    if text and lines:
        while lines[-1] and draw.textlength(lines[-1] + '…', font=selected_font) > width:
            lines[-1] = lines[-1][:-1]
        lines[-1] = lines[-1].rstrip() + '…'
    return lines


def time_text(ms):
    seconds = max(0, int(ms / 1000))
    return f'{seconds // 60:02d}:{seconds % 60:02d}'


def count_text(value):
    return f'{value:,}' if isinstance(value, int) and not isinstance(value, bool) else 'unknown'


def action_text(action):
    kind = action['type']
    if kind == 'command_execution':
        label = 'SHELL'
        if action.get('search', {}).get('search'):
            label += ' / RG OR GREP'
        if action.get('exitCode') is not None:
            label += f" / EXIT {action['exitCode']}"
        return label, shell_excerpt(action.get('command') or '(command unavailable)')
    if kind == 'mcp_tool_call':
        label = 'MCP / ' + str(action.get('tool') or 'unknown tool')
        args = action.get('arguments')
        if isinstance(args, dict):
            preferred = ('question', 'symbol', 'importSpecifier', 'testCommand', 'detail', 'scope', 'package', 'version')
            fields = {key: args[key] for key in preferred if key in args}
            if not fields:
                fields = args
            description = json.dumps(fields, ensure_ascii=False, separators=(', ', ': '))
        else:
            description = json.dumps(args, ensure_ascii=False)
        return label, description
    require(kind == 'file_change', 'Only public command, MCP and file change actions may be rendered')
    changes = action.get('changes', [])
    description = '; '.join(f"{change.get('kind') or 'change'} {short_path(change.get('path') or '(path unavailable)')}" for change in changes)
    return 'FILE CHANGE', description or '(file changes unavailable)'


def load_record(path, arm, guided=False):
    source = Path(path)
    raw = source.read_bytes()
    record = json.loads(raw)
    run = record.get('run', {})
    if guided:
        require(isinstance(run.get('id'), str) and run['id'].startswith('sqlite-rollback-') and run['id'] != 'sqlite-rollback-1-typelatch', 'A guided demonstration must have a distinct identity')
        require(run.get('arm') in ('typelatch', 'typelatch-guided', 'guided') and run.get('task') == 'sqlite-rollback', 'Guided run must perform the same SQLite task')
    else:
        require(run.get('id') == f'sqlite-rollback-1-{arm}', 'Replay selection is fixed to SQLite repeat 1')
        require(run.get('arm') == arm and run.get('task') == 'sqlite-rollback' and run.get('repeat') == 1, 'Run identity does not match selected pair')
    require(isinstance(run.get('elapsedMs'), (int, float)) and math.isfinite(run['elapsedMs']) and run['elapsedMs'] > 0, 'Measured task elapsed time is required')
    require(isinstance(record.get('actions'), list), 'Public action evidence is required')
    for action in record['actions']:
        require(action.get('type') in ('command_execution', 'mcp_tool_call', 'file_change'), 'Unexpected action type: never render model messages or reasoning')
        completed = action.get('completedMs')
        require(isinstance(completed, (int, float)) and math.isfinite(completed) and 0 <= completed <= run['elapsedMs'] + 100, 'Observed completion time is required for every displayed action')
        start = action.get('startedMs')
        require(start is None or (isinstance(start, (int, float)) and 0 <= start <= completed), 'Invalid observed action timing')
    require([action['completedMs'] for action in record['actions']] == sorted(action['completedMs'] for action in record['actions']), 'Public actions must retain observed completion order')
    if guided:
        succeeded = [action for action in record['actions'] if action['type'] == 'mcp_tool_call' and action.get('status') == 'completed' and action.get('hasResult') and not action.get('hasError') and not (action.get('result') or {}).get('isError')]
        require(len(succeeded) > 0 and len(succeeded) == run.get('counts', {}).get('mcpSucceeded'), 'A guided replay requires successful recorded MCP calls')
    # Defend the presentation boundary even if the caller supplies an unexpected file.
    require('reasoning' not in record and 'raw' not in record, 'Input must be the allowlisted public export')
    return {**record, '_sourceSha256': sha256(raw), '_sourceName': source.name}


def label(draw, xy, text, color=MUTED, size=13):
    draw.text(xy, text, fill=color, font=MONO[size])


def draw_card(draw, x, y, action, color, active):
    draw.rounded_rectangle((x, y, x + 452, y + 75), radius=9, fill=CARD if active else PANEL, outline=LINE)
    heading, excerpt = action_text(action)
    event_clock = time_text(action['completedMs'])
    max_heading = 373 - draw.textlength(event_clock, font=MONO[12])
    heading = text_lines(draw, heading, MONO[12], max_heading, 1)[0]
    label(draw, (x + 12, y + 9), heading, color if active else MUTED, 12)
    label(draw, (x + 405, y + 9), event_clock, MUTED, 12)
    for index, line in enumerate(text_lines(draw, excerpt, MONO[14], 426, 2)):
        draw.text((x + 12, y + 30 + index * 18), line, font=MONO[14], fill=PAPER)


def draw_final(draw, x, record, color):
    run = record['run']
    grade = record.get('grading') or {}
    correctness = run.get('correct')
    status = 'PASS' if correctness is True else 'FAIL' if correctness is False else 'UNKNOWN'
    status_color = LIME if correctness is True else CORAL if correctness is False else MUTED
    label(draw, (x + 24, 215), 'INDEPENDENT CORRECTNESS', MUTED, 13)
    draw.text((x + 24, 239), status, font=FONTS[36], fill=status_color)
    public = grade.get('publicTests') or {}
    heldout = grade.get('hiddenTests') or {}
    line = f"Public {count_text(public.get('pass'))}/{count_text(public.get('tests'))} · Held out {count_text(heldout.get('pass'))}/{count_text(heldout.get('tests'))}"
    draw.text((x + 24, 286), line, font=FONTS[15], fill=MUTED)
    draw.line((x + 24, 322, x + 476, 322), fill=LINE)
    label(draw, (x + 24, 344), 'ACTUAL TASK TIME', MUTED, 12)
    label(draw, (x + 264, 344), 'RG / GREP SHELL CALLS', MUTED, 12)
    draw.text((x + 24, 367), f"{run['elapsedMs'] / 1000:.1f}s", font=FONTS[28], fill=PAPER)
    draw.text((x + 264, 367), count_text(run.get('counts', {}).get('grepShellCalls')), font=FONTS[28], fill=PAPER)
    label(draw, (x + 24, 421), 'REPORTED TOTAL TOKENS', MUTED, 12)
    usage = run.get('usage') or {}
    draw.text((x + 24, 444), count_text(usage.get('totalTokens')), font=FONTS[28], fill=color)
    detail = f"{count_text(usage.get('inputTokens'))} input + {count_text(usage.get('outputTokens'))} output"
    draw.text((x + 24, 483), detail, font=FONTS[15], fill=MUTED)
    draw.text((x + 24, 507), f"Cached input: {count_text(usage.get('cachedInputTokens'))} (included)", font=FONTS[14], fill=MUTED)


def draw_frame(records, animation_ms, guided=False, explicit_use=False):
    image = Image.new('RGB', (WIDTH, HEIGHT), INK)
    draw = ImageDraw.Draw(image)
    draw.text((28, 20), 'typelatch.', font=FONTS[18], fill=PAPER)
    label(draw, (158, 24), 'ACTUAL CODEX CLI ACTIONS', LILAC, 13)
    draw.text((28, 53), 'One bug. Two Codex workflows.' if guided else 'One bug. Two Codex sessions.', font=FONTS[38], fill=PAPER)
    subtitle = 'Same task · tool guidance added on the right · supplemental demonstration' if guided else 'SQLite batch rollback · identical workflow prompt · repeat 1 · MCP when available' if explicit_use else 'SQLite batch rollback · identical task prompt · repeat 1 · Typelatch use optional'
    draw.text((28, 108), subtitle, font=FONTS[16], fill=MUTED)
    longest = max(record['run']['elapsedMs'] for record in records)
    fraction = min(1, max(0, (animation_ms - INTRO_MS) / PLAY_MS))
    event_time = fraction * longest
    final = animation_ms >= INTRO_MS + PLAY_MS
    for index, record in enumerate(records):
        x = 28 + index * 524
        color = PAPER if index == 0 else LILAC
        run = record['run']
        draw.rounded_rectangle((x, 153, x + 500, 568), radius=14, fill=PANEL, outline=LINE, width=1)
        heading = ('NATIVE TOOLS' if explicit_use else 'WITHOUT TYPELATCH') if index == 0 else 'TYPELATCH GUIDED' if guided else 'WITH TYPELATCH' if explicit_use else 'WITH TYPELATCH AVAILABLE'
        draw.text((x + 24, 171), heading, font=MONO[16], fill=color)
        label(draw, (x + 379, 173), f"{count_text(run.get('counts', {}).get('mcpCalls'))} MCP calls", MUTED, 12)
        draw.line((x, 200, x + 500, 200), fill=LINE)
        if final:
            draw_final(draw, x, record, color)
        else:
            shown = [action for action in record['actions'] if action['completedMs'] <= event_time]
            if not shown:
                draw.text((x + 24, 238), 'Session starts', font=FONTS[22], fill=PAPER)
                draw.text((x + 24, 279), 'Waiting for the first recorded tool event.', font=FONTS[15], fill=MUTED)
            for slot, action in enumerate(shown[-4:]):
                draw_card(draw, x + 24, 215 + slot * 79, action, color, action is shown[-1])
            seen_time = min(event_time, run['elapsedMs'])
            label(draw, (x + 24, 542), f"OBSERVED {time_text(seen_time)} / {time_text(run['elapsedMs'])}", MUTED, 12)
            if event_time >= run['elapsedMs']:
                label(draw, (x + 334, 542), 'SESSION ENDED', color, 12)
        draw.rectangle((x + 1, 565, x + 1 + 498 * min(1, event_time / run['elapsedMs']), 568), fill=color)
    draw.text((28, 588), 'Public action replay. Accelerated playback, not a screen recording.', font=FONTS[16], fill=PAPER)
    speed = longest / PLAY_MS
    draw.text((28, 615), f"{speed:.1f}× shared timeline · commands condensed · counts are recorded shell tool calls", font=FONTS[14], fill=MUTED)
    if guided:
        footer = 'Different prompts. Guided illustration only; excluded from the benchmark results.'
    elif explicit_use:
        footer = 'Matched workflow instructions. Use MCP when available; native tools otherwise.'
    elif all(record['run'].get('counts', {}).get('mcpCalls') == 0 for record in records):
        footer = 'Tool availability pair. Both sessions chose native tools; neither made an MCP call.'
    else:
        footer = 'One authored pair. Full results, prompts, commands and independent tests are on the site.'
    draw.text((28, 641), footer, font=FONTS[14], fill=MUTED)
    return image


def verify_fixture_pair(records, report, guided):
    allowed = {'node_modules/better-sqlite3/build/Makefile', 'node_modules/better-sqlite3/build/config.gypi'}
    comparisons = []
    for index, record in enumerate(records):
        run = record['run']
        supplemental = guided and index == 1
        comparison = record.get('fixtureComparison') if supplemental else report.get('fixtureComparisons', {}).get(run['id'])
        require(isinstance(comparison, dict), 'A recorded fixture comparison is required')
        require(comparison.get('rawManifestSha256') == run.get('fixtureSha256') == record.get('fixture', {}).get('manifestSha256'), 'Comparison must bind to the original run fixture inventory')
        require(isinstance(comparison.get('comparisonSha256'), str) and re.fullmatch(r'[a-f0-9]{64}', comparison['comparisonSha256']), 'Invalid comparison digest')
        require(all(row.get('path') in allowed for row in comparison.get('normalizations', [])), 'Only approved generated dependency metadata may be normalized')
        if not supplemental:
            source_run = next((item for item in report.get('runs', []) if item.get('id') == run['id']), None)
            require(source_run and source_run.get('evidenceSha256') == record['_sourceSha256'], 'Report must bind the exact public run evidence')
        comparisons.append(comparison)
    require(comparisons[0]['comparisonSha256'] == comparisons[1]['comparisonSha256'], 'Both sessions must start with matching source and dependency bytes after approved path normalization')
    return comparisons[0]['comparisonSha256']


def render(baseline_path, typelatch_path, output_dir, manifest_path, report_path, guided=False):
    report_bytes = Path(report_path).read_bytes()
    report = json.loads(report_bytes)
    require(report.get('complete') is True, 'Wait until the complete scored batch finishes before rendering')
    explicit_use = report.get('protocol', {}).get('study') == 'explicit-tool-use'
    records = [load_record(baseline_path, 'baseline'), load_record(typelatch_path, 'typelatch', guided)]
    baseline_prompt, comparison_prompt = records[0].get('prompt'), records[1].get('prompt')
    require(isinstance(baseline_prompt, str) and isinstance(comparison_prompt, str), 'Recorded prompts are required')
    if guided:
        require(comparison_prompt != baseline_prompt and comparison_prompt.startswith(baseline_prompt), 'Guided mode must preserve the original task and append explicit tool guidance')
    else:
        require(baseline_prompt == comparison_prompt, 'Both benchmark sessions must have the same task prompt')
    if explicit_use and not guided:
        calls = [action for action in records[1]['actions'] if action['type'] == 'mcp_tool_call']
        require(len(calls) > 0 and len(calls) == records[1]['run'].get('counts', {}).get('mcpCalls'), 'The selected actual use replay requires observed MCP calls; never substitute another pair')
    comparison_sha256 = verify_fixture_pair(records, report, guided)
    for key in ('model', 'model_reasoning_effort'):
        require(records[0].get('requestedConfig', {}).get(key) == records[1].get('requestedConfig', {}).get(key), f'Both sessions must use the same {key}')
    destination = Path(output_dir)
    destination.mkdir(parents=True, exist_ok=True)
    asset_name = 'codex-guided-comparison' if guided else 'codex-comparison'
    gif_path, poster_path = destination / f'{asset_name}.gif', destination / f'{asset_name}.png'
    frame_duration = 250
    previews = [draw_frame(records, instant, guided, explicit_use) for instant in (0, INTRO_MS + PLAY_MS // 2, DURATION_MS)]
    palette_sheet = Image.new('RGB', (WIDTH, HEIGHT * len(previews)))
    for index, preview in enumerate(previews):
        palette_sheet.paste(preview, (0, HEIGHT * index))
    palette = palette_sheet.quantize(colors=64)
    frames = [draw_frame(records, instant, guided, explicit_use).quantize(palette=palette, dither=Image.Dither.NONE) for instant in range(0, DURATION_MS, frame_duration)]
    frames[0].save(gif_path, save_all=True, append_images=frames[1:], duration=frame_duration, loop=0, optimize=True, disposal=1)
    draw_frame(records, DURATION_MS, guided, explicit_use).save(poster_path, optimize=True)
    require(gif_path.stat().st_size <= 1_000_000, f'Animation exceeds compact size target: {gif_path.stat().st_size} bytes')
    manifest = {
        'schemaVersion': 1, 'task': 'sqlite-rollback', 'repeat': 1,
        'kind': 'guided-demonstration' if guided else 'explicit-tool-use-benchmark' if explicit_use else 'availability-benchmark',
        'study': report.get('protocol', {}).get('study', 'automatic-tool-choice'),
        'runs': [{'id': record['run']['id'], 'evidenceSha256': record['_sourceSha256']} for record in records],
        'assets': {
            'gif': {'path': f'assets/{asset_name}.gif', 'sha256': sha256(gif_path.read_bytes())},
            'poster': {'path': f'assets/{asset_name}.png', 'sha256': sha256(poster_path.read_bytes())},
        },
        'dimensions': {'width': WIDTH, 'height': HEIGHT},
        'playback': {
            'durationMs': DURATION_MS, 'eventPlaybackMs': PLAY_MS,
            'label': 'Actual Codex CLI public action replay. Accelerated playback, not a screen recording.',
            'timing': 'Both sessions align at their own process start. Completed actions appear at observed event receipt times on one shared accelerated clock. Final metrics include complete measured session time. Independent grading is shown after the session.',
            'commands': 'Exact public command and argument excerpts with whitespace condensed and visible truncation. No model messages, reasoning or fabricated tool output.',
            'selection': 'Supplemental guided SQLite session compared with the unchanged first baseline. Extra tool instructions are appended only for the guided session. This demonstration is excluded from benchmark totals.' if guided else 'SQLite repeat 1 was selected before observing the outcome. Both conditions use the same task prompt and starting fixture.',
        },
        'fixtureComparison': {'comparisonSha256': comparison_sha256, 'policy': 'Only exact workspace paths in the two recorded better-sqlite3 generated metadata files are normalized. All other source and dependency bytes match.'},
        'reportSha256': sha256(report_bytes),
        'rendererSha256': sha256(Path(__file__).read_bytes()),
    }
    Path(manifest_path).write_text(json.dumps(manifest, indent=2) + '\n')
    return {'gif': str(gif_path), 'poster': str(poster_path), 'manifest': str(manifest_path), 'bytes': gif_path.stat().st_size, 'durationMs': DURATION_MS}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('baseline', type=Path, help='Public JSON for sqlite-rollback-1-baseline')
    parser.add_argument('typelatch', type=Path, nargs='?', help='Public JSON for sqlite-rollback-1-typelatch')
    parser.add_argument('--guided-record', type=Path, help='Supplemental SQLite public JSON with explicit Typelatch guidance')
    parser.add_argument('--output-dir', type=Path, default=ROOT / 'site/assets')
    parser.add_argument('--manifest', type=Path)
    parser.add_argument('--report', type=Path, default=ROOT / 'docs/benchmarks/paired-agent.json')
    args = parser.parse_args()
    require(bool(args.typelatch) != bool(args.guided_record), 'Supply either the benchmark Typelatch record or --guided-record')
    guided = args.guided_record is not None
    manifest = args.manifest or ROOT / ('site/guided-animation.json' if guided else 'site/benchmark-animation.json')
    print(json.dumps(render(args.baseline, args.guided_record or args.typelatch, args.output_dir, manifest, args.report, guided), indent=2))
