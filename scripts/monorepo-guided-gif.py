#!/usr/bin/env python3
"""Replay the preregistered native and experimental packet coding sessions."""
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
ARMS = ('native', 'packet')


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



KIND = 'inventory-guided-public-action-replay'
PUBLIC_PREFIX = 'evidence/monorepo-guided-study/'


def read_json(path):
    data = Path(path).read_bytes()
    return json.loads(data), sha256(data)


def local_file(directory, relative):
    require(isinstance(relative, str), 'A public relative evidence path is required')
    path = (directory / relative).resolve()
    require(path.is_relative_to(directory.resolve()), 'Evidence path escapes the public bundle')
    return path


def finite(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def workflow_status(adjudication, run_id):
    rows = ((adjudication.get('decision') or {}).get('workflowReview') or {}).get('runs', [])
    matches = [row for row in rows if row.get('id') == run_id]
    if len(matches) != 1 or matches[0].get('passed') not in (True, False):
        return 'unknown'
    if matches[0]['passed'] is True:
        return 'pass'
    return 'unknown' if matches[0].get('instructionFollowed') == 'unknown' else 'fail'


def validate_model_config(record, protocol, arm):
    config = record.get('requestedConfig') or {}
    model_config = {key: value for key, value in config.items() if not key.startswith('mcp_servers.')}
    require(model_config == protocol.get('config'), 'Requested model configuration differs from the protocol')
    observed = {key.split('.')[1] for key in config if key.startswith('mcp_servers.')}
    declared = set(protocol['spec']['arms'][arm].get('servers', {}))
    require(observed == declared, 'Requested providers differ from the declared arm inventory')


def load_inputs(report_path):
    directory = Path(report_path).resolve().parent
    report, report_hash = read_json(report_path)
    require(report.get('complete') is True and len(report.get('runs', [])) == 12,
            'Wait for every scheduled session and the final public export')
    wrapper, wrapper_hash = read_json(directory / 'protocol.json')
    require(wrapper.get('protocol') == report.get('protocol'), 'Public protocol and report disagree')
    require(wrapper.get('privateProtocolSha256') == report.get('protocolSha256'), 'Frozen protocol identity differs')
    protocol = report['protocol']
    selection = protocol.get('replaySelection') or {}
    require(selection.get('task') == protocol['tasks'][0]['id'] and selection.get('repeat') == 1,
            'Use the preregistered first task and first repeat')
    require(selection.get('arms') == list(ARMS), 'Replay arms must remain native and packet')
    expected_ids = [selection['task'] + '-r1-' + arm for arm in ARMS]
    require(selection.get('runIds') == expected_ids, 'Never replace the preselected pair')
    adjudication, adjudication_hash = read_json(directory / 'adjudication.json')
    require(adjudication.get('reportSha256') == report_hash, 'Adjudication is bound to another report')
    require(adjudication.get('protocolSha256') == report['protocolSha256'], 'Adjudication protocol differs')
    audit, audit_hash = read_json(directory / 'workflow-audit.json')
    require(adjudication.get('workflowAuditSha256') == audit_hash and audit.get('reportSha256') == report_hash,
            'Independent workflow audit must match the public report')
    records, bindings = [], []
    for arm, run_id in zip(ARMS, expected_ids):
        matches = [row for row in report['runs'] if row.get('id') == run_id]
        require(len(matches) == 1, 'Selected run is missing or duplicated')
        row = matches[0]
        require(row.get('arm') == arm and row.get('repeat') == 1 and row.get('task') == selection['task'],
                'Selected run identity differs')
        record, record_hash = read_json(local_file(directory, row['evidence']))
        require(record_hash == row.get('evidenceSha256'), 'Public action record digest differs')
        run = record.get('run') or {}
        require(all(row.get(key) == value for key, value in run.items()), 'Run measurements differ from the report')
        require(run.get('id') == run_id, 'Public record identity differs')
        require(finite(run.get('elapsedMs')) and run['elapsedMs'] > 0 and finite(run.get('providerSetupMs')) and run['providerSetupMs'] >= 0,
                'Measured agent and provider setup times are required')
        prompts = [p for p in protocol.get('prompts', []) if p.get('task') == selection['task'] and p.get('arm') == arm]
        require(len(prompts) == 1 and prompts[0]['prompt'] == record.get('prompt'), 'Exact sent prompt is required')
        require(sha256(record['prompt'].encode()) == run.get('promptSha256') == prompts[0].get('promptSha256'),
                'Per-arm prompt digest differs')
        require(record['prompt'].startswith(protocol['tasks'][0]['prompt'] + '\n\n'),
                'The same task and workflow must precede the declared arm inventory')
        actions = record.get('actions')
        require(isinstance(actions, list), 'Public action evidence is required')
        for action in actions:
            require(action.get('type') in ('command_execution', 'mcp_tool_call', 'file_change'),
                    'Never render model messages or reasoning')
            completed = action.get('completedMs')
            require(finite(completed) and 0 <= completed <= run['elapsedMs'] + 100,
                    'Every action needs an observed completion receipt time')
            started = action.get('startedMs')
            require(started is None or (finite(started) and 0 <= started <= completed), 'Invalid observed action times')
        require([a['completedMs'] for a in actions] == sorted(a['completedMs'] for a in actions),
                'Preserve the public action completion order')
        require(len({a['idSha256'] for a in actions}) == len(actions), 'Duplicate public action')
        for instant in {a['completedMs'] for a in actions}:
            require(sum(a['completedMs'] == instant for a in actions) <= 4,
                    'More than four simultaneous actions need an explicit additional replay page')
        usage = run.get('usage') or {}
        if all(isinstance(usage.get(k), int) for k in ('inputTokens', 'outputTokens', 'totalTokens')):
            require(usage['totalTokens'] == usage['inputTokens'] + usage['outputTokens'], 'Terminal token total differs')
        judgments = [a for a in audit.get('runs', []) if a.get('id') == run_id]
        require(len(judgments) == 1 and judgments[0].get('evidenceSha256') == record_hash, 'Independent run review is missing')
        record['_workflow'] = workflow_status(adjudication, run_id)
        validate_model_config(record, protocol, arm)
        output_path, output_hash = row.get('toolOutputs'), row.get('toolOutputsSha256')
        unavailable = None
        if output_path:
            output, actual_hash = read_json(local_file(directory, output_path))
            require(actual_hash == output_hash == judgments[0].get('toolOutputsSha256'), 'Tool output supplement digest differs')
            require(output.get('publicRecordSha256') == record_hash and output.get('rawCaptureSha256') == run.get('rawSha256'),
                    'Supplement provenance differs')
            expected = [a for a in actions if a['type'] in ('command_execution', 'mcp_tool_call')]
            require([a['idSha256'] for a in output.get('actions', [])] == [a['idSha256'] for a in expected],
                    'Supplement action set differs')
            for public_action, returned in zip(expected, output['actions']):
                key = 'resultSha256' if public_action['type'] == 'mcp_tool_call' else 'outputSha256'
                require(returned.get(key) == public_action.get(key), 'Supplement payload identity differs')
        else:
            require(output_hash is None and judgments[0].get('toolOutputsSha256') is None,
                    'Unavailable outputs cannot claim a supplement digest')
            receipt, receipt_hash = read_json(local_file(directory, row['unavailableToolOutputs']))
            require(receipt.get('status') == 'unavailable' and receipt.get('publicRecordSha256') == record_hash,
                    'Retain the explicit unavailable-output receipt')
            unavailable = {'path': PUBLIC_PREFIX + row['unavailableToolOutputs'], 'sha256': receipt_hash}
        bindings.append({'id': run_id, 'evidence': PUBLIC_PREFIX + row['evidence'], 'evidenceSha256': record_hash,
                         'toolOutputs': PUBLIC_PREFIX + output_path if output_path else None,
                         'toolOutputsSha256': output_hash, 'unavailableToolOutputs': unavailable})
        records.append(record)
    require(records[0]['run'].get('fixtureSha256') == records[1]['run'].get('fixtureSha256'), 'Starting fixture bytes differ')
    return {'report': report, 'adjudication': adjudication, 'records': records, 'bindings': bindings,
            'reportHash': report_hash, 'adjudicationHash': adjudication_hash, 'wrapperHash': wrapper_hash,
            'selection': selection}


def label(draw, xy, text, color=MUTED, size=13):
    draw.text(xy, text, fill=color, font=MONO[size])


def draw_card(draw, x, y, action, color, active):
    draw.rounded_rectangle((x, y, x + 452, y + 75), radius=9, fill=CARD if active else PANEL, outline=LINE)
    heading, excerpt = action_text(action)
    failed = action.get('status') == 'failed' or action.get('hasError') or (action.get('result') or {}).get('isError')
    shade = CORAL if failed else color if active else MUTED
    event_clock = time_text(action['completedMs'])
    heading_lines = text_lines(draw, heading, MONO[12], 370, 1)
    label(draw, (x + 12, y + 9), heading_lines[0] if heading_lines else '', shade, 12)
    label(draw, (x + 405, y + 9), event_clock, MUTED, 12)
    for index, line in enumerate(text_lines(draw, excerpt, MONO[14], 426, 2)):
        draw.text((x + 12, y + 30 + index * 18), line, font=MONO[14], fill=PAPER)


def draw_final(draw, x, record, color):
    run, grade = record['run'], record.get('grading') or {}
    correctness = run.get('correct')
    status = 'PASS' if correctness is True else 'FAIL' if correctness is False else 'UNKNOWN'
    status_color = LIME if correctness is True else CORAL if correctness is False else MUTED
    label(draw, (x + 24, 215), 'INDEPENDENT CORRECTNESS', MUTED, 13)
    draw.text((x + 24, 239), status, font=FONTS[36], fill=status_color)
    checks = (grade.get('checks') or {}).get('result') or {}
    cases, failed = checks.get('cases'), checks.get('failed')
    result = f"Independent cases: {cases - failed}/{cases}" if isinstance(cases, int) and isinstance(failed, int) else 'Independent case count unavailable'
    draw.text((x + 24, 284), result, font=FONTS[15], fill=MUTED)
    draw.text((x + 24, 305), 'Reviewed workflow: ' + clean(record['_workflow']).upper(), font=FONTS[14], fill=MUTED)
    draw.line((x + 24, 332, x + 476, 332), fill=LINE)
    label(draw, (x + 24, 347), 'CHARGED TIME', MUTED, 12)
    label(draw, (x + 264, 347), 'RG / GREP SHELL CALLS', MUTED, 12)
    charged = run['elapsedMs'] + run['providerSetupMs']
    draw.text((x + 24, 369), f"{charged / 1000:.1f}s", font=FONTS[28], fill=PAPER)
    draw.text((x + 264, 369), count_text((run.get('counts') or {}).get('grepShellCalls')), font=FONTS[28], fill=PAPER)
    detail = f"Agent {run['elapsedMs'] / 1000:.1f}s + setup {run['providerSetupMs'] / 1000:.2f}s"
    draw.text((x + 24, 405), detail, font=FONTS[14], fill=MUTED)
    label(draw, (x + 24, 434), 'TERMINAL TOTAL TOKENS', MUTED, 12)
    usage = run.get('usage') or {}
    draw.text((x + 24, 457), count_text(usage.get('totalTokens')), font=FONTS[28], fill=color)
    draw.text((x + 24, 496), f"{count_text(usage.get('inputTokens'))} input + {count_text(usage.get('outputTokens'))} output", font=FONTS[14], fill=MUTED)
    detail = f"Cached input {count_text(usage.get('cachedInputTokens'))}, included"
    draw.text((x + 24, 518), detail, font=FONTS[14], fill=MUTED)
    draw.text((x + 24, 540), f"Recorded MCP calls: {count_text((run.get('counts') or {}).get('mcpCalls'))}", font=FONTS[14], fill=MUTED)


def draw_frame(records, event_time=0, final=False):
    image = Image.new('RGB', (WIDTH, HEIGHT), INK)
    draw = ImageDraw.Draw(image)
    draw.text((28, 20), 'typelatch.', font=FONTS[18], fill=PAPER)
    label(draw, (158, 24), 'PUBLIC CODEX ACTION REPLAY', LILAC, 13)
    draw.text((28, 53), 'One repair. Two Codex sessions.', font=FONTS[38], fill=PAPER)
    draw.text((28, 108), 'Same task and workflow. Explicit provider inventories. First task, repeat 1.', font=FONTS[16], fill=MUTED)
    for index, record in enumerate(records):
        x, color = 28 + index * 524, PAPER if index == 0 else LILAC
        run = record['run']
        draw.rounded_rectangle((x, 153, x + 500, 568), radius=14, fill=PANEL, outline=LINE)
        label(draw, (x + 24, 174), 'NATIVE TOOLS' if index == 0 else 'EXPERIMENTAL PACKET', color, 16)
        draw.line((x, 200, x + 500, 200), fill=LINE)
        if final:
            draw_final(draw, x, record, color)
        else:
            shown = [a for a in record['actions'] if a['completedMs'] <= event_time]
            if not shown:
                draw.text((x + 24, 238), 'Session starts', font=FONTS[22], fill=PAPER)
                draw.text((x + 24, 279), 'Waiting for the first recorded tool event.', font=FONTS[15], fill=MUTED)
            for slot, action in enumerate(shown[-4:]):
                draw_card(draw, x + 24, 215 + slot * 79, action, color, action is shown[-1])
            latest = shown[-1]['completedMs'] if shown else 0
            label(draw, (x + 24, 542), 'LAST COMPLETED EVENT ' + time_text(latest), MUTED, 12)
            if event_time >= run['elapsedMs']:
                label(draw, (x + 334, 542), 'SESSION ENDED', color, 12)
        draw.rectangle((x + 1, 565, x + 1 + 498 * min(1, event_time / run['elapsedMs']), 568), fill=color)
    draw.text((28, 588), 'Separate sessions aligned at start. Accelerated replay, not a screen recording.', font=FONTS[16], fill=PAPER)
    draw.text((28, 615), 'Observed completion timestamps. Reading pauses added. Commands condensed.', font=FONTS[14], fill=MUTED)
    draw.text((28, 641), 'Preselected pair, including failures. Final totals only. Full study and evidence are linked.', font=FONTS[14], fill=MUTED)
    return image


def render(report_path, output_dir, manifest_path, contact_sheet=None):
    data = load_inputs(report_path)
    records = data['records']
    longest = max(record['run']['elapsedMs'] for record in records)
    times = sorted({0, longest, *(a['completedMs'] for record in records for a in record['actions'])})
    timeline_end = times[-1]
    # Every distinct completion is a frame. Brief shared reading holds never invent an event time.
    minimum = min(450, PLAY_MS * 0.6 / len(times))
    leftover = PLAY_MS - minimum * len(times)
    durations = [max(10, round((minimum + leftover * (right - left) / timeline_end) / 10) * 10)
                 for left, right in zip(times, times[1:] + [timeline_end])]
    durations[-1] += PLAY_MS - sum(durations)
    images = [draw_frame(records, 0)] + [draw_frame(records, t) for t in times] + [draw_frame(records, longest, True)]
    duration_values = [INTRO_MS] + durations + [FINAL_MS]
    require(len(images) == len(duration_values) and sum(duration_values) == DURATION_MS, 'Playback duration accounting differs')
    palette_sheet = Image.new('RGB', (WIDTH, HEIGHT * 3))
    for index, preview in enumerate((images[0], images[len(images) // 2], images[-1])):
        palette_sheet.paste(preview, (0, HEIGHT * index))
    palette = palette_sheet.quantize(colors=64)
    frames = [frame.quantize(palette=palette, dither=Image.Dither.NONE) for frame in images]
    destination = Path(output_dir)
    destination.mkdir(parents=True, exist_ok=True)
    gif_path, poster_path = destination / 'codex-guided-comparison.gif', destination / 'codex-guided-comparison.png'
    require(not gif_path.exists() and not poster_path.exists() and not Path(manifest_path).exists(),
            'Refuse to overwrite an existing replay or manifest')
    frames[0].save(gif_path, save_all=True, append_images=frames[1:], duration=duration_values, loop=0, optimize=True, disposal=1)
    images[-1].save(poster_path, optimize=True)
    require(gif_path.stat().st_size <= 1_000_000, 'Replay exceeds the 1 MB compact asset target')
    if contact_sheet:
        palette_sheet.save(contact_sheet)
    manifest = {
        'schemaVersion': 1, 'kind': KIND, 'task': data['selection']['task'], 'repeat': 1, 'arms': list(ARMS),
        'runs': data['bindings'], 'protocolSha256': data['report']['protocolSha256'],
        'report': {'path': PUBLIC_PREFIX + 'report.json', 'sha256': data['reportHash']},
        'adjudication': {'path': PUBLIC_PREFIX + 'adjudication.json', 'sha256': data['adjudicationHash']},
        'protocol': {'path': PUBLIC_PREFIX + 'protocol.json', 'sha256': data['wrapperHash']},
        'renderer': {'path': 'scripts/monorepo-guided-gif.py', 'sha256': sha256(Path(__file__).read_bytes())},
        'assets': {name: {'path': 'assets/' + path.name, 'sha256': sha256(path.read_bytes()),
                          'width': WIDTH, 'height': HEIGHT, 'bytes': path.stat().st_size}
                   for name, path in (('gif', gif_path), ('poster', poster_path))},
        'dimensions': {'width': WIDTH, 'height': HEIGHT},
        'playback': {'durationMs': DURATION_MS, 'durationSeconds': DURATION_MS / 1000, 'accelerated': True,
                     'separateSessionsAlignedAtStart': True, 'eventTimes': times, 'readingHolds': True,
                     'renderedActionIds': {r['run']['id']: [a['idSha256'] for a in r['actions']] for r in records},
                     'timing': 'Completed actions use measured receipt timestamps. One shared timeline aligns process starts; reading holds change playback spacing. Provider setup is included only in labelled charged-time totals.',
                     'tokens': 'Only terminal totals are shown. Cached input is a subset already included in total input; no interpolated token counters.',
                     'selection': data['selection']['rule']},
        'caption': 'Actual public Codex action replay. Shared task and workflow with explicit per-arm provider inventories. Native tools and experimental packet. Accelerated playback of separate sessions, including observed failures. Not a screen recording.',
    }
    Path(manifest_path).write_text(json.dumps(manifest, indent=2) + '\n')
    return {'gif': str(gif_path), 'poster': str(poster_path), 'manifest': str(manifest_path),
            'bytes': gif_path.stat().st_size, 'durationMs': DURATION_MS, 'frames': len(frames)}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--report', type=Path, default=ROOT / 'docs/benchmarks/monorepo-guided-study/report.json')
    parser.add_argument('--output-dir', type=Path, default=ROOT / 'site/assets')
    parser.add_argument('--manifest', type=Path, default=ROOT / 'site/guided-animation.json')
    parser.add_argument('--contact-sheet', type=Path)
    args = parser.parse_args()
    print(json.dumps(render(args.report, args.output_dir, args.manifest, args.contact_sheet), indent=2))
