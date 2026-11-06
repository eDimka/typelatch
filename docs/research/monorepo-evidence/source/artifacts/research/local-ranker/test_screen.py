import copy
import json
from pathlib import Path
import tempfile
import unittest

import screen


class FakeTokenizer:
    def encode(self, text, add_special_tokens=False):
        return list(range(len(text.split())))


class BoundaryTests(unittest.TestCase):
    def setUp(self):
        self.case = {
            "id": "fixture",
            "query": "find the requested implementation",
            "candidates": [
                {"id": "first", "text": "export " * 2000},
                {"id": "second", "text": "short relevant implementation"},
            ],
            "relevantIds": ["second"],
            "privateLabelExplanation": "DO_NOT_SEND_LABELS",
        }

    def test_bound_preserves_exact_text_and_records_omissions(self):
        prepared = screen.prepare_case(self.case, FakeTokenizer())
        for original, item in zip(self.case["candidates"], prepared["candidates"]):
            self.assertLessEqual(item["inputTokens"], 512)
            self.assertTrue(original["text"].startswith(item["text"]))
            self.assertEqual(item["omittedCharacters"], len(original["text"]) - len(item["text"]))
        self.assertGreater(prepared["candidates"][0]["omittedCharacters"], 0)
        self.assertEqual(prepared["candidates"][1]["omittedCharacters"], 0)

    def test_labels_do_not_change_model_input(self):
        other = copy.deepcopy(self.case)
        other["relevantIds"] = ["first"]
        a = screen.prepare_case(self.case, FakeTokenizer())
        b = screen.prepare_case(other, FakeTokenizer())
        self.assertEqual(a["candidates"], b["candidates"])
        request_a = screen.ollama_request(a, "qwen3:1.7b", 5)
        request_b = screen.ollama_request(b, "qwen3:1.7b", 5)
        self.assertEqual(request_a, request_b)
        self.assertNotIn("DO_NOT_SEND_LABELS", json.dumps(request_a))
        self.assertNotIn("relevantIds", json.dumps(request_a))

    def test_duplicate_ids_are_rejected(self):
        self.case["candidates"][1]["id"] = "first"
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "cases.json"
            path.write_text(json.dumps({"schemaVersion": 1, "cases": [self.case]}))
            with self.assertRaisesRegex(ValueError, "duplicate candidate"):
                screen.read_cases(path)

    def test_invalid_selection_retains_observed_usage(self):
        prepared = screen.prepare_case(self.case, FakeTokenizer())
        def http(*args):
            return {"done": True, "done_reason": "stop", "prompt_eval_count": 77,
                    "eval_count": 9, "total_duration": 123456,
                    "message": {"content": '{"rankedIds":["invented"]}'}}
        result = screen.run_ollama(prepared, "qwen3:1.7b", 5, http, 10)
        self.assertEqual(result["status"], "error")
        self.assertIsNone(result["rankedIds"])
        self.assertEqual(result["inputTokens"], 77)
        self.assertEqual(result["outputTokens"], 9)
        self.assertEqual(result["usage"]["total_duration"], 123456)
        self.assertGreaterEqual(result["requestWallMs"], 0)

    def test_transport_failure_is_retained_without_zero_usage(self):
        def http(*args):
            raise TimeoutError("test timeout")
        prepared = screen.prepare_case(self.case, FakeTokenizer())
        result = screen.run_ollama(prepared, "qwen3:1.7b", 5, http, 10)
        self.assertEqual(result["status"], "error")
        self.assertIsNone(result.get("inputTokens"))
        self.assertIn("TimeoutError", result["error"])
        self.assertGreaterEqual(result["requestWallMs"], 0)
        self.assertFalse(result["safeToContinue"])

    def test_rank_quality_has_the_same_top_k_cutoff(self):
        result = screen.metrics(["first", "second"], ["second"], 1)
        self.assertEqual(result["reciprocalRankAtK"], 0)

    def test_initial_model_residency_is_observed(self):
        def http(path):
            return {
                "/api/tags": {"models": [{"name": "qwen3:1.7b", "digest": "frozen"}]},
                "/api/version": {"version": "test"},
                "/api/ps": {"models": [{"name": "qwen3:1.7b", "digest": "frozen", "size_vram": 1024}]},
            }[path]
        identity = screen.ollama_identity(http, "qwen3:1.7b", "frozen")
        self.assertEqual(identity["residency"], "warm")
        self.assertEqual(identity["loadedModels"][0]["size_vram"], 1024)

    def test_empty_relevance_has_explicit_separate_evaluation(self):
        result = screen.metrics(["first"], [], 5)
        self.assertIsNone(result["recallAtK"])
        self.assertFalse(result["emptySelectionCorrect"])
        self.assertTrue(screen.metrics([], [], 5)["emptySelectionCorrect"])

    def test_remote_endpoint_is_rejected_without_request(self):
        with self.assertRaisesRegex(ValueError, "loopback"):
            screen.local_http("https://example.com")
        with self.assertRaisesRegex(ValueError, "suffix"):
            screen.local_http("http://127.0.0.1:11434/extra")


if __name__ == "__main__":
    unittest.main()
