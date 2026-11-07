import copy
import runpy
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parent.parent
REPLAY = runpy.run_path(str(ROOT / 'scripts/cross-package-confirmation-gif.py'))
REPORT = ROOT / 'docs/research/cross-package/confirmation-002/results/report.json'


class ConfirmationReplayTests(unittest.TestCase):
    def test_exact_first_confirmation_pair_and_audits(self):
        data = REPLAY['load_inputs'](REPORT)
        self.assertEqual([record['run']['arm'] for record in data['records']], ['native', 'impact'])
        self.assertEqual([record['_workflow'] for record in data['records']], ['pass', 'pass'])
        self.assertEqual(data['selection']['repeat'], 1)
        self.assertEqual(data['report']['protocol']['phase'], 'confirmation')

    def test_changed_report_or_selected_pair_is_rejected(self):
        original = REPLAY['read_json']
        def altered(path):
            value, digest = original(path)
            if Path(path) == REPORT:
                value = copy.deepcopy(value)
                value['protocol']['replaySelection']['arms'] = ['native', 'competitor']
            return value, digest
        with patch.dict(REPLAY['load_inputs'].__globals__, {'read_json': altered}):
            with self.assertRaises(ValueError):
                REPLAY['load_inputs'](REPORT)

    def test_review_files_must_be_listed_in_export_manifest(self):
        original = REPLAY['read_json']
        for filename in ('workflow-audit.json', 'adjudicated-result.json', 'codegraph-challenge.json', 'codegraph-challenge-policy.json', 'occurrence-assessment-v1.json', 'control-audit.json'):
            def altered(path):
                value, digest = original(path)
                if Path(path).name == 'manifest.json':
                    value = copy.deepcopy(value)
                    value['files'] = [entry for entry in value['files'] if entry['path'] != filename]
                return value, digest
            with patch.dict(REPLAY['load_inputs'].__globals__, {'read_json': altered}):
                with self.assertRaises(ValueError):
                    REPLAY['load_inputs'](REPORT)

    def test_model_change_or_undeclared_provider_is_rejected(self):
        protocol = {'config': {'model': 'same'}, 'spec': {'arms': {'native': {'servers': {}}}}}
        for config in [{'model': 'different'}, {'model': 'same', 'mcp_servers.hidden.command': 'x'}]:
            with self.assertRaises(ValueError):
                REPLAY['validate_model_config']({'requestedConfig': config}, protocol, 'native')

    def test_failed_mcp_action_is_named_as_an_error(self):
        label, _ = REPLAY['action_text']({'type':'mcp_tool_call','tool':'package_evidence','status':'completed','hasError':False,'result':{'isError':True},'arguments':{}})
        self.assertIn('ERROR', label)

    def test_model_messages_are_never_replay_events(self):
        with self.assertRaises(ValueError):
            REPLAY['action_text']({'type': 'reasoning', 'text': 'private'})


    def test_full_study_failed_gate_and_all_session_costs_are_retained(self):
        data = REPLAY['load_inputs'](REPORT)
        full = data['fullStudy']
        self.assertEqual(full['sessionCount'], 16)
        self.assertFalse(full['qualifiedEdge'])
        self.assertEqual(full['arms']['native']['totalTokens'], 886587)
        self.assertEqual(full['arms']['impact']['totalTokens'], 749471)
        self.assertAlmostEqual(full['nativeTokenGate']['aggregateReductionPercent'], 15.46560010467106)
        self.assertEqual(full['originalStrictPass'], 11)
        self.assertEqual(full['occurrenceAssessedPass'], 15)

    def test_a_passing_or_partial_study_cannot_receive_failed_gate_caption(self):
        data = REPLAY['load_inputs'](REPORT)
        assessed = data['supplemental']['occurrence-assessment-v1.json']['value']
        changed = copy.deepcopy(data['adjudication'])
        changed['decision']['candidates']['impact']['overall']['qualifiedEdge'] = True
        with self.assertRaises(ValueError):
            REPLAY['confirmation_context'](data['report'], changed, assessed)
        partial = copy.deepcopy(data['report'])
        partial['runs'].pop()
        with self.assertRaises(ValueError):
            REPLAY['confirmation_context'](partial, data['adjudication'], assessed)

    def test_every_frame_requires_the_failed_full_study_context(self):
        data = REPLAY['load_inputs'](REPORT)
        with self.assertRaises(ValueError):
            REPLAY['draw_frame'](data['records'])
        with self.assertRaises(ValueError):
            REPLAY['draw_frame'](data['records'], full_study={'qualifiedEdge': True})

if __name__ == '__main__':
    unittest.main()
