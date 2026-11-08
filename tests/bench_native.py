#!/usr/bin/env python3
"""A/B throughput study driver for the dsh-rdm kernel (0.2.0 pass).

Drives two kernel binaries through the NDJSON protocol against the native
perf-origin (tests/perf-origin.rs, no artificial delays) and reports medians of
`start -> terminal` wall time plus the kernel event phase marks. It runs inside
the DSH agent sandbox because Python can spawn child processes where Node cannot.

Build the origin and prepare the pristine binary first:

    mkdir -p tests/.tmp-e2e
    rustc -O -o tests/.tmp-e2e/perf-origin.exe tests/perf-origin.rs
    git show HEAD:bin/<host>/rdm-kernel[.exe] > tests/.tmp-e2e/old-kernel[.exe]
    cargo build --release --manifest-path kernel/Cargo.toml

Usage:
    python tests/bench_native.py \
      --old tests/.tmp-e2e/old-kernel.exe \
      --new kernel/target/release/rdm-kernel.exe \
      --origin tests/.tmp-e2e/perf-origin.exe \
      --out tests/.bench/native-0.2.0.json

The numbers are host-specific; the ratios and the phase decomposition are what
generalize (see docs/OPTIMIZATION.md §9).
"""

from __future__ import annotations

import argparse
import json
import os
import queue
import shutil
import statistics
import subprocess
import sys
import threading
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TMP_ROOT = os.path.join(ROOT, "tests", ".tmp-e2e", "bench-native")
MIB = 1024 * 1024


class Origin:
    """The native range origin (tests/perf-origin.rs)."""

    def __init__(self, executable: str, size: int) -> None:
        self.proc = subprocess.Popen(
            [executable, "--size", str(size)],
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            text=True,
            bufsize=1,
        )
        line = (self.proc.stdout.readline() if self.proc.stdout else "").strip()
        if not line.startswith("PORT "):
            raise RuntimeError(f"perf-origin did not report a port: {line!r}")
        self.port = int(line.split()[1])

    def close(self) -> None:
        if self.proc.poll() is None:
            self.proc.kill()


class Kernel:
    """One kernel process driven over NDJSON (no host plugin needed)."""

    def __init__(self, binary: str, data_dir: str) -> None:
        self.lines: queue.Queue = queue.Queue()
        self.proc = subprocess.Popen(
            [binary, "--data-dir", data_dir, "--log-level", "error"],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            text=True,
            bufsize=1,
        )
        threading.Thread(target=self._pump, daemon=True).start()
        self.next_id = 0
        self._await_event("ready", 20.0)
        self.request("initialize", {
            "defaultDir": data_dir,
            "connections": 8,
            "chunkSizeBytes": 0,
            "maxAttempts": 3,
            "autoResume": False,
            "logLevel": "error",
        })

    def _pump(self) -> None:
        assert self.proc.stdout is not None
        for line in self.proc.stdout:
            try:
                self.lines.put(json.loads(line))
            except json.JSONDecodeError:
                pass

    def _await_event(self, event: str, timeout: float) -> dict:
        deadline = time.time() + timeout
        while time.time() < deadline:
            try:
                message = self.lines.get(timeout=max(0.05, deadline - time.time()))
            except queue.Empty:
                continue
            if message.get("event") == event:
                return message
        raise TimeoutError(f"kernel did not emit {event!r}")

    def request(self, method: str, params: dict, timeout: float = 240.0) -> dict:
        self.next_id += 1
        request_id = f"b{self.next_id}"
        assert self.proc.stdin is not None
        self.proc.stdin.write(json.dumps({"id": request_id, "method": method, "params": params}) + "\n")
        self.proc.stdin.flush()
        deadline = time.time() + timeout
        while time.time() < deadline:
            try:
                message = self.lines.get(timeout=max(0.05, deadline - time.time()))
            except queue.Empty:
                continue
            if message.get("id") == request_id:
                if not message.get("ok"):
                    raise RuntimeError(f"{method}: {message.get('error')}")
                return message.get("result") or {}
        raise TimeoutError(method)

    def close(self) -> None:
        if self.proc.poll() is None:
            try:
                self.proc.stdin.close()  # type: ignore[union-attr]
            except Exception:
                pass
            try:
                self.proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self.proc.kill()


def run_round(binary: str, port: int, size: int, connections: int, tag: str) -> dict:
    data_dir = os.path.join(TMP_ROOT, "data")
    download_dir = os.path.join(TMP_ROOT, "downloads")
    shutil.rmtree(data_dir, ignore_errors=True)
    shutil.rmtree(download_dir, ignore_errors=True)
    os.makedirs(data_dir, exist_ok=True)
    os.makedirs(download_dir, exist_ok=True)
    kernel = Kernel(binary, data_dir)
    try:
        url = f"http://127.0.0.1:{port}/file-{tag}.bin"
        started = time.perf_counter()
        task = kernel.request("start", {
            "url": url,
            "dir": download_dir,
            "fileName": f"{tag}.bin",
            "connections": connections,
        }).get("task") or {}
        result = kernel.request("wait", {"ids": [task.get("id")], "timeoutMs": 180000})
        wall_ms = (time.perf_counter() - started) * 1000
        final = (result.get("tasks") or [{}])[0]
        if final.get("status") != "completed":
            raise RuntimeError(f"status {final.get('status')} error={final.get('error')}")
        events = kernel.request("get", {"id": task.get("id"), "events": 100}).get("events") or []
        marks: dict[str, int] = {}
        for event in events:
            marks.setdefault(event.get("kind"), event.get("at") or 0)
        phases = {}
        if marks.get("probe") and marks.get("plan"):
            phases["probeMs"] = marks["plan"] - marks["probe"]
        if marks.get("plan") and marks.get("started"):
            phases["prepareMs"] = marks["started"] - marks["plan"]
        if marks.get("started") and marks.get("completed"):
            phases["transferMs"] = marks["completed"] - marks["started"]
        return {"wallMs": wall_ms, "phases": phases}
    finally:
        kernel.close()


def bench_case(origin: str, old: str, new: str, size_mib: int, connections: int, rounds: int) -> dict:
    size = size_mib * MIB
    renderer = Origin(origin, size)
    try:
        samples: dict[str, list[float]] = {"old": [], "new": []}
        phases: dict[str, list[dict]] = {"old": [], "new": []}
        for index in range(rounds):
            order = ("old", "new") if index % 2 == 0 else ("new", "old")
            for label in order:
                binary = old if label == "old" else new
                result = run_round(binary, renderer.port, size, connections, f"{size_mib}-{index}")
                samples[label].append(result["wallMs"])
                phases[label].append(result["phases"])
        row: dict = {"sizeMiB": size_mib, "connections": connections}
        for label in ("old", "new"):
            phase_medians = {}
            for key in ("probeMs", "prepareMs", "transferMs"):
                values = [phase[key] for phase in phases[label] if key in phase]
                phase_medians[key] = round(statistics.median(values), 1) if values else None
            row[label] = {
                "medianMs": round(statistics.median(samples[label]), 1),
                "minMs": round(min(samples[label]), 1),
                "maxMs": round(max(samples[label]), 1),
                "mibPerSec": round(size_mib / (statistics.median(samples[label]) / 1000), 1),
                "phases": phase_medians,
            }
        return row
    finally:
        renderer.close()


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--old", required=True, help="pristine 0.1.2 kernel binary")
    parser.add_argument("--new", required=True, help="current kernel binary")
    parser.add_argument("--origin", required=True, help="perf-origin executable (rustc tests/perf-origin.rs)")
    parser.add_argument("--out", default=os.path.join(ROOT, "tests", ".bench", "native-0.2.0.json"))
    parser.add_argument("--rounds-1mib", type=int, default=10)
    parser.add_argument("--rounds-10mib", type=int, default=8)
    parser.add_argument("--rounds-64mib", type=int, default=5)
    args = parser.parse_args()
    for path in (args.old, args.new, args.origin):
        if not os.path.exists(path):
            print(f"missing binary: {path}", file=sys.stderr)
            return 2
    os.makedirs(TMP_ROOT, exist_ok=True)
    cases = [
        (1, 8, args.rounds_1mib),
        (10, 8, args.rounds_10mib),
        (64, 8, args.rounds_64mib),
        (64, 1, max(2, args.rounds_64mib // 2)),
    ]
    report = {"host": sys.platform, "old": args.old, "new": args.new, "origin": args.origin, "cases": []}
    for size_mib, connections, rounds in cases:
        row = bench_case(args.origin, args.old, args.new, size_mib, connections, rounds)
        report["cases"].append(row)
        print(json.dumps(row))
    os.makedirs(os.path.dirname(args.out), exist_ok=True)
    with open(args.out, "w", encoding="utf-8") as handle:
        json.dump(report, handle, indent=2)
    print(f"wrote {args.out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
