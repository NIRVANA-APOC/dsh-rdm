#!/usr/bin/env python3
"""Claim-level dynamic probes for dsh-rdm 0.2.0 (verifier-owned).

Each probe checks one README/PROTOCOL/design claim against the real kernel
binary, independently of the shipped suites:

  1. canonical credential redaction — signed query values become `<redacted>`
     in probe facts / task views / detail / event messages, and request headers
     and cookies never appear in any protocol view (README security section,
     PROTOCOL.md "Credential redaction");
  2. preflight latency — server facts are readable well inside the 2 s
     `waitProbeMs` budget (design §8.3);
  3. notifications stay flat — `{"event":"task","task":<TaskView>}`, never
     TaskDetail (design §8.2 / PROTOCOL.md "Notifications");
  4. `shutdown` replies on the request id and exits in < 2 s (PROTOCOL.md).

Run: python tests/verify_claims.py [--kernel path] [--json out.json]
Exit code 0 = every claimed behaviour observed.
"""

from __future__ import annotations

import argparse
import json
import os
import queue
import shutil
import subprocess
import sys
import threading
import time
import traceback

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "tests"))

from verify_e2e import Fixture, Kernel, wait_task  # noqa: E402

TMP_ROOT = os.path.join(ROOT, "tests", ".tmp-verify-claims")
CHECKS: list[dict] = []


def check(name: str, ok: bool, detail=None) -> bool:
    entry: dict = {"name": name, "ok": bool(ok)}
    if not ok:
        entry["detail"] = detail if isinstance(detail, (str, int, float, type(None))) else repr(detail)[:600]
        print(f"  FAIL {name}: {entry['detail']}")
    CHECKS.append(entry)
    return bool(ok)


class SafeKernel(Kernel):
    """UTF-8 pipe variant of the shipped driver (Windows default is GBK)."""

    def __init__(self, binary: str, data_dir: str) -> None:
        self.lines: queue.Queue = queue.Queue()
        self.stderr_lines: list[str] = []
        self.proc = subprocess.Popen(
            [binary, "--data-dir", data_dir, "--log-level", "warn"],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            encoding="utf-8",
            errors="replace",
            bufsize=1,
        )
        threading.Thread(target=self._pump_stdout, daemon=True).start()
        threading.Thread(target=self._pump_stderr, daemon=True).start()
        self.next_id = 0
        self.ready = self._await_event("ready", timeout=20.0)
        self.notifications: list[dict] = []


def fresh(name: str) -> tuple[str, str]:
    base = os.path.join(TMP_ROOT, name)
    shutil.rmtree(base, ignore_errors=True)
    data = os.path.join(base, "data")
    downloads = os.path.join(base, "downloads")
    os.makedirs(data, exist_ok=True)
    os.makedirs(downloads, exist_ok=True)
    return data, downloads


def initialize(kernel: Kernel, default_dir: str) -> None:
    kernel.request(
        "initialize",
        {
            "defaultDir": default_dir,
            "connections": 4,
            "chunkSizeBytes": 0,
            "speedLimitBps": 0,
            "maxAttempts": 3,
            "autoResume": False,
            "logLevel": "warn",
            "fsyncOnComplete": False,
        },
    )


# ── 1. canonical credential redaction ──────────────────────────────────────
def probe_redaction(fixture: Fixture, binary: str) -> None:
    data, downloads = fresh("redaction")
    kernel = SafeKernel(binary, data)
    secrets = ["SECRETTOKEN123", "SECRETCOOKIE456", "SECRETSIG789", "SECRETAPIKEY000"]
    try:
        initialize(kernel, downloads)
        size = 256 * 1024
        signed = (
            fixture.url
            + f"/ranged/{size}/redact.bin"
            + "?X-Amz-Signature=SECRETSIG789&X-Amz-Credential=SECRETAPIKEY000"
            + "&X-Amz-Date=20260101T000000Z&sig=SECRETTOKEN123"
        )
        facts = kernel.request("probe", {"url": signed}).get("server") or {}
        check("redaction.probe.url has <redacted>", "<redacted>" in (facts.get("url") or ""), facts.get("url"))
        check(
            "redaction.probe.url preserved non-secret X-Amz-Date",
            "X-Amz-Date=20260101T000000Z" in (facts.get("url") or ""),
            facts.get("url"),
        )
        started = kernel.request(
            "start",
            {
                "url": signed,
                "dir": downloads,
                "fileName": "redact.bin",
                "headers": {"Authorization": "Bearer SECRETTOKEN123"},
                "cookie": "session=SECRETCOOKIE456",
            },
        ).get("task") or {}
        check("redaction.task.url has <redacted>", "<redacted>" in (started.get("url") or ""), started.get("url"))
        final = wait_task(kernel, started.get("id"), timeout=90)
        view = kernel.request("get", {"id": started.get("id")})
        detail = view.get("detail") or {}
        blob = json.dumps({"start": started, "final": final, "view": view, "list": kernel.request("list", {}), "stats": kernel.request("stats")})
        leaked = [secret for secret in secrets if secret in blob]
        check("redaction.no credential value in any protocol view", leaked == [], leaked)
        check(
            "redaction.detail.server.url redacted",
            "<redacted>" in ((detail.get("server") or {}).get("url") or ""),
            (detail.get("server") or {}).get("url"),
        )
    finally:
        kernel.close()


# ── 2. preflight latency ───────────────────────────────────────────────────
def probe_preflight(fixture: Fixture, binary: str) -> None:
    data, downloads = fresh("preflight")
    kernel = SafeKernel(binary, data)
    try:
        initialize(kernel, downloads)
        size = 4 * 1024 * 1024
        url = fixture.url + f"/ranged/{size}/preflight.bin"
        t0 = time.perf_counter()
        started = kernel.request(
            "start", {"url": url, "dir": downloads, "fileName": "preflight.bin", "connections": 4}
        ).get("task") or {}
        start_ms = (time.perf_counter() - t0) * 1000
        check("preflight.start responds quickly (<1000 ms)", start_ms < 1000, f"{start_ms:.1f} ms")
        t1 = time.perf_counter()
        server = None
        polls = 0
        while time.perf_counter() - t1 < 2.0:
            polls += 1
            current = kernel.request("get", {"id": started.get("id")})
            server = (current.get("detail") or {}).get("server")
            if server is not None:
                break
            time.sleep(0.02)
        facts_ms = (time.perf_counter() - t1) * 1000
        check(
            "preflight.server facts available within 2000 ms",
            server is not None and facts_ms < 2000,
            f"{facts_ms:.1f} ms, totalBytes={(server or {}).get('totalBytes')}",
        )
        check("preflight.server totalBytes correct", (server or {}).get("totalBytes") == size, (server or {}).get("totalBytes"))
        wait_task(kernel, started.get("id"), timeout=90)
    finally:
        kernel.close()


# ── 3. flat notifications ──────────────────────────────────────────────────
def probe_notifications(fixture: Fixture, binary: str) -> None:
    data, downloads = fresh("notifications")
    kernel = SafeKernel(binary, data)
    try:
        initialize(kernel, downloads)
        size = 2 * 1024 * 1024
        started = kernel.request(
            "start",
            {
                "url": fixture.url + f"/slow/{size}/notify.bin?chunk=16384&delay=8",
                "dir": downloads,
                "fileName": "notify.bin",
                "connections": 2,
            },
        ).get("task") or {}
        events = []
        deadline = time.time() + 15
        while time.time() < deadline:
            try:
                message = kernel.lines.get(timeout=0.2)
            except queue.Empty:
                if events and events[-1]["task"].get("status") in {"completed", "failed", "cancelled"}:
                    break
                continue
            if message.get("event") == "task":
                events.append(message)
                if message["task"].get("status") in {"completed", "failed", "cancelled"}:
                    break
        detail_keys = {"telemetry", "target", "verification", "resumeState", "timing", "diagnosis"}
        check("notifications.task frames observed", len(events) > 0, len(events))
        check(
            "notifications.envelope is {event,task}",
            all(set(event.keys()) == {"event", "task"} for event in events),
            [sorted(event.keys()) for event in events[:2]],
        )
        check(
            "notifications.task is flat TaskView (no TaskDetail keys)",
            all(not (detail_keys & set(event["task"].keys())) for event in events),
            None,
        )
        check(
            "notifications.statuses include running",
            any(event["task"].get("status") == "running" for event in events),
            sorted({event["task"].get("status") for event in events}),
        )
        wait_task(kernel, started.get("id"), timeout=90)
    finally:
        kernel.close()


# ── 4. shutdown reply + exit time ──────────────────────────────────────────
def probe_shutdown(binary: str) -> None:
    base = os.path.join(TMP_ROOT, "shutdown")
    shutil.rmtree(base, ignore_errors=True)
    os.makedirs(base, exist_ok=True)
    proc = subprocess.Popen(
        [binary, "--data-dir", base, "--log-level", "warn"],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        encoding="utf-8",
        errors="replace",
        bufsize=1,
    )
    lines: queue.Queue = queue.Queue()
    threading.Thread(
        target=lambda: [lines.put(json.loads(line)) for line in proc.stdout if line.strip()],
        daemon=True,
    ).start()
    try:
        lines.get(timeout=10)  # ready
        t0 = time.perf_counter()
        assert proc.stdin is not None
        proc.stdin.write(json.dumps({"id": "shutdown-1", "method": "shutdown", "params": {}}) + "\n")
        proc.stdin.flush()
        response = lines.get(timeout=5)
        reply_ms = (time.perf_counter() - t0) * 1000
        proc.wait(timeout=5)
        exit_ms = (time.perf_counter() - t0) * 1000
        check("shutdown.response id/ok", response.get("id") == "shutdown-1" and response.get("ok") is True, response)
        check("shutdown.reply within 2 s", reply_ms < 2000, f"{reply_ms:.1f} ms")
        check("shutdown.process exits within 2 s", exit_ms < 2000 and proc.returncode == 0, f"{exit_ms:.1f} ms exit={proc.returncode}")
    finally:
        if proc.poll() is None:
            proc.kill()


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--kernel", default=os.path.join(ROOT, "bin", "win32-x64", "rdm-kernel.exe"))
    parser.add_argument("--json", default=None)
    args = parser.parse_args()
    os.makedirs(TMP_ROOT, exist_ok=True)
    if not os.path.exists(args.kernel):
        print(f"kernel binary not found: {args.kernel}", file=sys.stderr)
        return 2
    started = time.time()
    fixture = None
    try:
        fixture = Fixture()
        for label, fn in (
            ("credential redaction", lambda: probe_redaction(fixture, args.kernel)),
            ("preflight latency", lambda: probe_preflight(fixture, args.kernel)),
            ("flat notifications", lambda: probe_notifications(fixture, args.kernel)),
            ("shutdown", lambda: probe_shutdown(args.kernel)),
        ):
            print(f"[claims] probe: {label}")
            try:
                fn()
            except Exception:
                traceback.print_exc()
                check(f"{label}.exception", False, traceback.format_exc()[-800:])
    finally:
        if fixture is not None:
            fixture.close()
    elapsed = time.time() - started
    passed = sum(1 for entry in CHECKS if entry["ok"])
    failed = [entry for entry in CHECKS if not entry["ok"]]
    print(f"\nclaims: {passed}/{len(CHECKS)} checks passed in {elapsed:.1f}s")
    for entry in failed:
        print(f"  FAILED: {entry['name']} :: {entry.get('detail')}")
    payload = {
        "kernel": os.path.abspath(args.kernel),
        "checks": CHECKS,
        "passed": passed,
        "failed": len(failed),
        "elapsedSec": round(elapsed, 2),
        "generatedAt": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
    }
    if args.json:
        with open(args.json, "w", encoding="utf-8") as handle:
            json.dump(payload, handle, indent=2)
        print(f"[claims] wrote {args.json}")
    return 0 if not failed and passed > 0 else 1


if __name__ == "__main__":
    sys.exit(main())
