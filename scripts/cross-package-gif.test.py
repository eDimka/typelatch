import copy
import runpy
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parent.parent
REPLAY = runpy.run_path(str(ROOT / 'scripts/cross-package-gif.py'))
REPORT = ROOT / 'docs/research/cross-package/impact-002/results/report.json'


class ImpactReplayTests(unittest.TestCase):
    def test_exact_first_development_pair_and_audits(self):
        data = REPLAY['load_inputs'](REPORT)
        self.assertEqual([record['run']['arm'] for record in data['records']], ['native', 'impact'])
        self.assertEqual([record['_workflow'] for record in data['records']], ['pass', 'pass'])
        self.assertEqual(data['selection']['repeat'], 1)
        self.assertEqual(data['report']['protocol']['phase'], 'development')

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
        for filename in ('workflow-audit.json', 'adjudicated-result.json'):
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


if __name__ == '__main__':
    unittest.main()
