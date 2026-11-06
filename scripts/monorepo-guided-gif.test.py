import runpy
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
REPLAY = runpy.run_path(str(ROOT / 'scripts/monorepo-guided-gif.py'))

class ReplayEvidenceTests(unittest.TestCase):
    def test_actual_preselected_pair_accepts_only_declared_provider_difference(self):
        data = REPLAY['load_inputs'](ROOT / 'docs/benchmarks/monorepo-guided-study/report.json')
        self.assertEqual([r['run']['arm'] for r in data['records']], ['native', 'packet'])
        self.assertEqual([r['_workflow'] for r in data['records']], ['pass', 'pass'])

    def test_final_adjudication_overrides_manual_pass(self):
        decision = {'decision': {'workflowReview': {'runs': [
            {'id': 'r', 'passed': False, 'instructionFollowed': 'pass'}
        ]}}}
        self.assertEqual(REPLAY['workflow_status'](decision, 'r'), 'fail')
        self.assertEqual(REPLAY['workflow_status'](decision, 'missing'), 'unknown')

    def test_model_change_and_undeclared_provider_are_rejected(self):
        protocol = {'config': {'model': 'same'}, 'spec': {'arms': {'native': {'servers': {}}}}}
        with self.assertRaises(ValueError):
            REPLAY['validate_model_config']({'requestedConfig': {'model': 'other'}}, protocol, 'native')
        with self.assertRaises(ValueError):
            REPLAY['validate_model_config']({'requestedConfig': {'model': 'same', 'mcp_servers.hidden.command': 'x'}}, protocol, 'native')

if __name__ == '__main__':
    unittest.main()
