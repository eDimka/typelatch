#!/usr/bin/env python3
"""Replay the preselected confirmation pair with the failed overall gate visible."""
import argparse
import hashlib
import json
import math
import re
import shlex
import statistics
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
ARMS = ('native', 'impact')


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
        if action.get('status') == 'failed' or action.get('hasError') or (action.get('result') or {}).get('isError'):
            label += ' / ERROR'
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



KIND = 'cross-package-confirmation-action-replay'
PUBLIC_PREFIX = 'evidence/cross-package/confirmation-002/'


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


def validate_model_config(record, protocol, arm):
    config = record.get('requestedConfig') or {}
    model_config = {key: value for key, value in config.items() if not key.startswith('mcp_servers.')}
    require(model_config == protocol.get('config'), 'Requested model configuration differs from the protocol')
    observed = {key.split('.')[1] for key in config if key.startswith('mcp_servers.')}
    declared = set(protocol['spec']['arms'][arm].get('servers', {}))
    require(observed == declared, 'Requested providers differ from the declared arm inventory')


def confirmation_context(report, adjudication, assessment):
    runs, protocol = report['runs'], report['protocol']
    require(len(runs) == 16 and protocol['repeats'] == 2 and len(protocol['tasks']) == 2,
            'Full study context requires all sixteen sessions and both tasks and repeats')
    require(protocol['arms'] == ['native', 'impact', 'competitor', 'codegraph'], 'All four conditions must remain visible')
    decision = adjudication['decision']
    require(decision['anyQualifiedEdge'] is False and decision['candidates']['impact']['overall']['qualifiedEdge'] is False,
            'This failed-gate replay cannot silently display a passing or unknown outcome')
    threshold = protocol['decisionGate']['minimumReductionPercent']
    require(threshold == 20, 'Keep the prespecified gate')
    totals = {}
    for arm in protocol['arms']:
        selected = [run for run in runs if run['arm'] == arm]
        require(len(selected) == 4, 'Every arm must retain all four sessions')
        for run in selected:
            require(finite(run['elapsedMs']) and run['elapsedMs'] >= 0 and finite(run['providerSetupMs']) and run['providerSetupMs'] >= 0,
                    'Complete charged times are required')
            require(run['usage']['totalTokens'] == run['usage']['inputTokens'] + run['usage']['outputTokens'], 'Full-study token accounting differs')
        totals[arm] = {'sessions': len(selected), 'totalTokens': sum(run['usage']['totalTokens'] for run in selected),
                       'chargedTimeMs': sum(run['elapsedMs'] + run['providerSetupMs'] for run in selected),
                       'originalStrictPass': sum(run['correct'] is True for run in selected)}
    comparisons = {}
    for control in ('native', 'competitor', 'codegraph'):
        comparisons[control] = {name: 100 * (1 - totals['impact'][metric] / totals[control][metric])
                               for name, metric in (('totalTokenReductionPercent', 'totalTokens'), ('chargedTimeReductionPercent', 'chargedTimeMs'))}
    pairs = []
    for candidate in [run for run in runs if run['arm'] == 'impact']:
        controls = [run for run in runs if run['arm'] == 'native' and run['task'] == candidate['task'] and run['repeat'] == candidate['repeat']]
        require(len(controls) == 1, 'Each candidate session needs its exact native pair')
        pairs.append(100 * (1 - candidate['usage']['totalTokens'] / controls[0]['usage']['totalTokens']))
    aggregate = comparisons['native']['totalTokenReductionPercent']
    median = statistics.median(pairs)
    require(aggregate < threshold and median < threshold, 'The displayed token-gate failure must follow from all measured pairs')
    retained = decision['candidates']['impact']['overall']['comparisons']['native']['metrics']['totalTokens']
    require(math.isclose(aggregate, retained['aggregateReductionPercent']) and math.isclose(median, retained['medianPairedReductionPercent']),
            'Recomputed full-study result differs from the reviewed decision')
    strict = sum(run['correct'] is True for run in runs)
    require(assessment['originalGradesUnchanged'] is True and assessment['originalDecisionsUnchanged'] is True, 'Occurrence review must preserve the original result')
    require(assessment['summary']['answers'] == 16 and assessment['summary']['originalStrictPass'] == strict, 'Separate assessment counts differ')
    require({run['id'] for run in assessment['runs']} == {run['id'] for run in runs} and len(assessment['runs']) == 16, 'Assess every retained answer')
    for row in assessment['runs']:
        original = next(run for run in runs if run['id'] == row['id'])
        require(row['originalCorrect'] == original['correct'] and row['evidenceSha256'] == original['evidenceSha256']
                and row['toolOutputsSha256'] == original['toolOutputsSha256'], 'Occurrence review binds the original answer evidence')
    assessed = sum(row['assessedCorrect'] is True for row in assessment['runs'])
    require(assessed == assessment['summary']['assessedPass'], 'Occurrence assessment count differs')
    return {'sessionCount': 16, 'taskCount': 2, 'repeats': 2, 'qualifiedEdge': False,
            'minimumReductionPercent': threshold, 'arms': totals, 'comparisons': comparisons,
            'nativeTokenGate': {'aggregateReductionPercent': aggregate, 'medianPairedReductionPercent': median, 'passed': False},
            'originalStrictPass': strict, 'occurrenceAssessedPass': assessed,
            'scope': 'Original strict grading and a separate occurrence-contract assessment are distinct. The overall failed gate is unchanged.'}


def load_inputs(report_path):
    directory = Path(report_path).resolve().parent
    report, report_hash = read_json(report_path)
    protocol, protocol_hash = read_json(directory.parent / 'protocol.json')
    freeze, _ = read_json(directory.parent / 'freeze.json')
    manifest, manifest_hash = read_json(directory / 'manifest.json')
    require(protocol_hash == '2464bdb2404b1247d4aeea9aecec5b24e9b8702fffd709cda00eb3afb8262e8c', 'Only the frozen confirmation protocol may be replayed')
    require(protocol == report.get('protocol') and protocol.get('phase') == 'confirmation', 'The replay must bind the confirmation protocol')
    require(freeze.get('publicProtocolSha256') == protocol_hash and freeze.get('privateProtocolSha256') == report.get('protocolSha256'), 'Protocol identity differs')
    require(manifest.get('privateProtocolSha256') == report['protocolSha256'], 'Manifest protocol differs')
    files = {}
    for entry in manifest['files']:
        path = local_file(directory, entry['path'])
        payload = path.read_bytes()
        require(len(payload) == entry['bytes'] and sha256(payload) == entry['sha256'], 'Exported evidence digest differs')
        require(entry['path'] not in files, 'Manifest repeats a file')
        files[entry['path']] = entry
    require(files['report.json']['sha256'] == report_hash and files['report.json']['originalSha256'] == manifest['privateReportSha256'], 'Report provenance differs')
    require(report.get('complete') is True and len(report.get('runs', [])) == protocol.get('runCount') == 16, 'Retain all sixteen confirmation sessions')
    require([{k: r[k] for k in ('id', 'task', 'repeat', 'arm')} for r in report['runs']] == protocol['schedule'], 'Keep the frozen schedule')
    selection = protocol['replaySelection']
    require(selection['task'] == protocol['tasks'][0]['id'] and selection['repeat'] == 1 and selection['arms'] == list(ARMS), 'Never substitute a better pair')
    expected_ids = [selection['task'] + '-r1-' + arm for arm in ARMS]
    adjudication, adjudication_hash = read_json(directory / 'adjudicated-result.json')
    audit, audit_hash = read_json(directory / 'workflow-audit.json')
    require(files.get('workflow-audit.json', {}).get('sha256') == audit_hash, 'Workflow review must be bound by the export manifest')
    require(files.get('adjudicated-result.json', {}).get('sha256') == adjudication_hash, 'Reviewed decision must be bound by the export manifest')
    for item in (adjudication, audit):
        require(item['reportSha256'] == manifest['privateReportSha256'] and item['protocolSha256'] == report['protocolSha256'], 'Reviewed study identity differs')
    canonical_audit = json.dumps(audit, separators=(',', ':'), ensure_ascii=False).encode()
    require(adjudication['auditSha256'] == sha256(canonical_audit), 'Adjudication binds canonical audit values')
    supplemental = {}
    for name in ('codegraph-challenge.json', 'codegraph-challenge-policy.json', 'occurrence-assessment-v1.json', 'control-audit.json'):
        value, digest = read_json(directory / name)
        require(files.get(name, {}).get('sha256') == digest, 'Every consumed assessment must be bound by the export manifest')
        supplemental[name] = {'value': value, 'sha256': digest}
    for name in ('occurrence-assessment-v1.json', 'control-audit.json'):
        value = supplemental[name]['value']
        require(value['reportSha256'] == manifest['privateReportSha256'] and value['protocolSha256'] == report['protocolSha256'], 'Assessment belongs to another study')
    challenge = supplemental['codegraph-challenge.json']['value']
    require(challenge['reportSha256'] == manifest['privateReportSha256'] and challenge['protocolSha256'] == report['protocolSha256'], 'CodeGraph challenge belongs to another study')
    require(challenge['auditSha256'] == sha256(canonical_audit) and challenge['policySha256'] == supplemental['codegraph-challenge-policy.json']['sha256'], 'Challenge must bind the reviewed workflow and frozen policy')
    require(challenge['qualifiedAcrossMeasuredControls'] is False, 'Preserve the failed full-control gate')
    full_study = confirmation_context(report, adjudication, supplemental['occurrence-assessment-v1.json']['value'])
    records, bindings = [], []
    for arm, run_id in zip(ARMS, expected_ids):
        rows = [r for r in report['runs'] if r['id'] == run_id]
        require(len(rows) == 1, 'Selected run is absent or duplicated')
        row = rows[0]
        path = 'runs/' + run_id + '/public-evidence.json'
        record, record_hash = read_json(local_file(directory, path))
        require(record_hash == row['evidenceSha256'] == files[path]['sha256'], 'Selected record digest differs')
        run = record['run']
        require(run == {k: v for k, v in row.items() if k not in ('evidenceSha256', 'toolOutputsSha256')}, 'Public measurements differ')
        prompts = [p for p in protocol['prompts'] if p['task'] == selection['task'] and p['arm'] == arm]
        require(len(prompts) == 1 and record['prompt'] == prompts[0]['prompt'], 'Exact sent prompt differs')
        require(sha256(record['prompt'].encode()) == run['promptSha256'] == prompts[0]['promptSha256'], 'Prompt digest differs')
        validate_model_config(record, protocol, arm)
        require(finite(run.get('elapsedMs')) and run['elapsedMs'] > 0 and finite(run.get('providerSetupMs')) and run['providerSetupMs'] >= 0, 'Observed charged time is required')
        actions = record['actions']
        require(len({a['idSha256'] for a in actions}) == len(actions), 'Action identities repeat')
        require([a['completedMs'] for a in actions] == sorted(a['completedMs'] for a in actions), 'Keep completion order')
        for action in actions:
            require(action['type'] in ('command_execution', 'mcp_tool_call', 'file_change'), 'Never render model thoughts or messages')
            require(finite(action.get('completedMs')) and 0 <= action['completedMs'] <= run['elapsedMs'] + 100, 'Every action requires an observed completion receipt')
            require(action.get('startedMs') is None or (finite(action['startedMs']) and 0 <= action['startedMs'] <= action['completedMs']), 'Invalid action start')
        for instant in {a['completedMs'] for a in actions}:
            require(sum(a['completedMs'] == instant for a in actions) <= 4, 'More simultaneous actions require another replay page')
        usage = run['usage']
        require(usage['totalTokens'] == usage['inputTokens'] + usage['outputTokens'], 'Terminal token totals do not reconcile')
        judgments = [r for r in audit['runs'] if r['id'] == run_id]
        require(len(judgments) == 1 and judgments[0]['evidenceSha256'] == record_hash, 'Run review is absent')
        record['_workflow'] = judgments[0]['workflow']
        output_path = 'runs/' + run_id + '/tool-outputs.json'
        output, output_hash = read_json(local_file(directory, output_path))
        require(output_hash == row['toolOutputsSha256'] == files[output_path]['sha256'] == judgments[0]['toolOutputsSha256'], 'Returned evidence digest differs')
        require(output['publicRecordSha256'] == record_hash and output['rawCaptureSha256'] == run['rawSha256'], 'Returned evidence provenance differs')
        expected = [a for a in actions if a['type'] in ('command_execution', 'mcp_tool_call')]
        require([a['idSha256'] for a in output['actions']] == [a['idSha256'] for a in expected], 'Keep every returned action')
        for action, returned in zip(expected, output['actions']):
            key = 'resultSha256' if action['type'] == 'mcp_tool_call' else 'outputSha256'
            require(action[key] == returned[key], 'Returned payload identity differs')
        bindings.append({'id': run_id, 'evidence': PUBLIC_PREFIX + 'results/' + path, 'evidenceSha256': record_hash,
                         'toolOutputs': PUBLIC_PREFIX + 'results/' + output_path, 'toolOutputsSha256': output_hash})
        records.append(record)
    require(records[0]['run']['fixtureSha256'] == records[1]['run']['fixtureSha256'], 'Starting source bytes differ')
    return {'report': report, 'adjudication': adjudication, 'records': records, 'bindings': bindings,
            'reportHash': report_hash, 'adjudicationHash': adjudication_hash, 'wrapperHash': protocol_hash,
            'manifestHash': manifest_hash, 'auditHash': audit_hash, 'selection': selection,
            'supplemental': supplemental, 'fullStudy': full_study}


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
    label(draw, (x + 24, 215), 'ORIGINAL STRICT CORRECTNESS', MUTED, 13)
    draw.text((x + 24, 239), status, font=FONTS[36], fill=status_color)
    precision, recall = grade.get('precision'), grade.get('recall')
    result = f'Precision {precision:.0%} / recall {recall:.0%}' if finite(precision) and finite(recall) else 'Evidence grade retained in raw record'
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


def draw_frame(records, event_time=0, final=False, full_study=None):
    require(full_study is not None and full_study['qualifiedEdge'] is False, 'Always show the bound failed-study context')
    image = Image.new('RGB', (WIDTH, HEIGHT), INK)
    draw = ImageDraw.Draw(image)
    draw.text((28, 20), 'typelatch.', font=FONTS[18], fill=PAPER)
    label(draw, (158, 24), 'PUBLIC CODEX ACTION REPLAY', LILAC, 13)
    draw.rounded_rectangle((638, 13, 1052, 45), radius=6, fill=CORAL)
    draw.text((650, 21), 'OVERALL CONFIRMATION GATE: FAILED', font=MONO[14], fill=INK)
    draw.text((28, 53), 'One task. Two recorded sessions.', font=FONTS[38], fill=PAPER)
    draw.text((28, 108), 'Preselected first task and repeat. Shared workflow with explicit provider inventories.', font=FONTS[16], fill=MUTED)
    for index, record in enumerate(records):
        x, color = 28 + index * 524, PAPER if index == 0 else LILAC
        run = record['run']
        draw.rounded_rectangle((x, 153, x + 500, 568), radius=14, fill=PANEL, outline=LINE)
        label(draw, (x + 24, 174), 'NATIVE TOOLS' if index == 0 else 'EXPERIMENTAL IMPACT QUERY', color, 16)
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
    reduction = full_study['nativeTokenGate']['aggregateReductionPercent']
    time_reduction = full_study['comparisons']['native']['chargedTimeReductionPercent']
    draw.text((28, 615), f'Full study vs native: {reduction:.1f}% fewer tokens and {time_reduction:.1f}% less charged time. Both had to reach 20%.', font=FONTS[14], fill=MUTED)
    draw.text((28, 641), 'First pair only. Recorded event times, reading pauses and condensed commands. Final per-session totals.', font=FONTS[14], fill=MUTED)
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
    images = [draw_frame(records, 0, full_study=data['fullStudy'])] + [draw_frame(records, t, full_study=data['fullStudy']) for t in times] + [draw_frame(records, longest, True, data['fullStudy'])]
    duration_values = [INTRO_MS] + durations + [FINAL_MS]
    require(len(images) == len(duration_values) and sum(duration_values) == DURATION_MS, 'Playback duration accounting differs')
    palette_sheet = Image.new('RGB', (WIDTH, HEIGHT * 3))
    for index, preview in enumerate((images[0], images[len(images) // 2], images[-1])):
        palette_sheet.paste(preview, (0, HEIGHT * index))
    palette = palette_sheet.quantize(colors=64)
    frames = [frame.quantize(palette=palette, dither=Image.Dither.NONE) for frame in images]
    destination = Path(output_dir)
    destination.mkdir(parents=True, exist_ok=True)
    gif_path, poster_path = destination / 'cross-package-confirmation.gif', destination / 'cross-package-confirmation.png'
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
        'report': {'path': PUBLIC_PREFIX + 'results/report.json', 'sha256': data['reportHash']},
        'adjudication': {'path': PUBLIC_PREFIX + 'results/adjudicated-result.json', 'sha256': data['adjudicationHash']},
        'protocol': {'path': PUBLIC_PREFIX + 'protocol.json', 'sha256': data['wrapperHash']},
        'workflowAudit': {'path': PUBLIC_PREFIX + 'results/workflow-audit.json', 'sha256': data['auditHash']},
        'exportManifest': {'path': PUBLIC_PREFIX + 'results/manifest.json', 'sha256': data['manifestHash']},
        'codegraphChallenge': {'path': PUBLIC_PREFIX + 'results/codegraph-challenge.json', 'sha256': data['supplemental']['codegraph-challenge.json']['sha256']},
        'codegraphChallengePolicy': {'path': PUBLIC_PREFIX + 'results/codegraph-challenge-policy.json', 'sha256': data['supplemental']['codegraph-challenge-policy.json']['sha256']},
        'occurrenceAssessment': {'path': PUBLIC_PREFIX + 'results/occurrence-assessment-v1.json', 'sha256': data['supplemental']['occurrence-assessment-v1.json']['sha256']},
        'controlAudit': {'path': PUBLIC_PREFIX + 'results/control-audit.json', 'sha256': data['supplemental']['control-audit.json']['sha256']},
        'fullStudy': data['fullStudy'],
        'renderer': {'path': 'scripts/cross-package-confirmation-gif.py', 'sha256': sha256(Path(__file__).read_bytes())},
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
        'caption': 'Actual public Codex action replay of the preselected first task and repeat. Native tools and experimental impact query, shared workflow with explicit provider inventories. This pair is not the full study. The overall 16 session confirmation gate failed. Accelerated separate sessions, observed failures retained, final session totals only. Not a screen recording.',
    }
    Path(manifest_path).write_text(json.dumps(manifest, indent=2) + '\n')
    return {'gif': str(gif_path), 'poster': str(poster_path), 'manifest': str(manifest_path),
            'bytes': gif_path.stat().st_size, 'durationMs': DURATION_MS, 'frames': len(frames)}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--report', type=Path, default=ROOT / 'docs/research/cross-package/confirmation-002/results/report.json')
    parser.add_argument('--output-dir', type=Path, default=ROOT / 'site/assets')
    parser.add_argument('--manifest', type=Path, default=ROOT / 'site/cross-package-confirmation-animation.json')
    parser.add_argument('--contact-sheet', type=Path)
    args = parser.parse_args()
    print(json.dumps(render(args.report, args.output_dir, args.manifest, args.contact_sheet), indent=2))
