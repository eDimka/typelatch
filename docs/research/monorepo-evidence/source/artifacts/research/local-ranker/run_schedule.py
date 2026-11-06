#!/usr/bin/env python3
"""Run the fixed development screen schedule sequentially with external timing."""
import argparse
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import time

HERE = Path(__file__).resolve().parent
DIGEST = "8f68893c685c3ddff2aa3fffce2aa60a30bb2da65ca488b61fff134a4d1730e7"


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cases", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    args = parser.parse_args()
    cases = args.cases.resolve(strict=True)
    args.output_dir.mkdir(parents=True, exist_ok=False)
    output = args.output_dir.resolve()
    script = HERE / "screen.py"
    schedule = {
        "schemaVersion": 1, "kind": "development-local-selector-screen",
        "frozenAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "casesSha256": digest(cases), "screenScriptSha256": digest(script),
        "runnerSha256": digest(Path(__file__)),
        "topK": 2, "repeatsPerBackend": 2, "ollamaDigest": DIGEST,
        "order": ["mlx-1", "mlx-2", "ollama-1", "ollama-2"],
        "caseOrder": "file order", "noSelectiveReruns": True,
        "timing": "Each measured command runs alone after fixture qualification; external process wall time includes interpreter startup and final serialization.",
        "results": [{"id": name, "status": "not-run"} for name in ["mlx-1", "mlx-2", "ollama-1", "ollama-2"]],
    }
    (output / "schedule.json").write_text(json.dumps(schedule, indent=2) + "\n")
    for index, name in enumerate(schedule["order"]):
        if digest(cases) != schedule["casesSha256"] or digest(script) != schedule["screenScriptSha256"]:
            raise RuntimeError("frozen input changed")
        backend = name.split("-")[0]
        result_path = output / (name + ".json")
        command = [sys.executable, str(script), "--backend", backend,
                   "--cases", str(cases), "--output", str(result_path), "--top-k", "2"]
        if backend == "ollama":
            command += ["--expected-ollama-digest", DIGEST]
        print(json.dumps({"starting": name}), flush=True)
        start = time.perf_counter()
        try:
            child = subprocess.run(command, capture_output=True, text=True, timeout=600)
            row = {"id": name, "status": "finished", "exitCode": child.returncode,
                   "processWallMs": (time.perf_counter() - start) * 1000}
            (output / (name + ".stdout.log")).write_text(child.stdout)
            (output / (name + ".stderr.log")).write_text(child.stderr)
        except subprocess.TimeoutExpired as error:
            row = {"id": name, "status": "timeout", "exitCode": None,
                   "processWallMs": (time.perf_counter() - start) * 1000}
            for label, value in (("stdout", error.stdout), ("stderr", error.stderr)):
                (output / (name + "." + label + ".log")).write_bytes(
                    value if isinstance(value, bytes) else (value or "").encode())
        report = json.loads(result_path.read_text()) if result_path.exists() and result_path.stat().st_size else None
        row["reportStatus"] = report.get("status") if report else None
        row["reportSha256"] = digest(result_path) if result_path.exists() else None
        schedule["results"][index] = row
        safe = row["status"] != "timeout" and (backend == "mlx" or (
            report and report.get("unload", {}).get("status") == "ok"))
        if not safe:
            for remaining in schedule["results"][index + 1:]:
                remaining["reason"] = "Prior process or model quiescence is unconfirmed"
        (output / "execution.json").write_text(json.dumps(schedule, indent=2) + "\n")
        print(json.dumps(row), flush=True)
        if not safe:
            return 1
    return 0 if all(row["exitCode"] == 0 for row in schedule["results"]) else 1


if __name__ == "__main__":
    raise SystemExit(main())
