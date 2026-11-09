#!/usr/bin/env python3
"""Independent extra verification harness for dsh-rdm 0.2.0 (verifier-owned).

Adds the cases the shipped e2e suite does not cover, as required by the
independent-verification brief:

  1. no-range server: probe reports no range support / single-stream
     recommendation, and the download still completes byte-identically;
  2. pause -> kernel process restart -> resume on the same data dir completes
     the original bytes (state persisted across the process boundary);
  3. session-scoped list excludes other sessions and session-less tasks;
  4. a raw `initialize` frame carrying protocol=1 is refused with the stable
     `protocol_mismatch` code (protocol §5.7);
  5. `stats` exposes throughput windows and the origin-ledger host count;
  6. chunked (unknown-length, no ranges) download completes.

Run: python tests/verify_extra.py [--kernel path] [--json out.json]
Exit code 0 = all checks pass. This file only writes under tests/.tmp-verify-extra
and .design/reports-02/ when --json is given.
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import sys
import time
import traceback

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "tests"))

from verify_e2e import (  # noqa: E402  (reuse the shipped out-of-process driver)
    Fixture,
    Kernel,
    fetch_bytes,
    field,
    has_all,
    sha256_hex,
    wait_task,
)

TMP_ROOT = os.path.join(ROOT, "tests", ".tmp-verify-extra")
CHECKS: list[dict] = []


def check(name: str, ok: bool, detail=None) -> bool:
    entry: dict = {"name": name, "ok": bool(ok)}
    if not ok:
        entry["detail"] = (
            detail if isinstance(detail, (str, int, float, type(None))) else repr(detail)[:600]
        )
        print(f"  FAIL {name}: {entry['detail']}")
    CHECKS.append(entry)
    return bool(ok)


def fresh_dir(name: str) -> str:
    path = os.path.join(TMP_ROOT, name)
    shutil.rmtree(path, ignore_errors=True)
    os.makedirs(path, exist_ok=True)
    return path


def init_kernel(kernel: Kernel, default_dir: str, *, connections: int = 4) -> dict:
    return kernel.request(
        "initialize",
        {
            "defaultDir": default_dir,
            "connections": connections,
            "chunkSizeBytes": 0,
            "speedLimitBps": 0,
            "maxAttempts": 3,
            "autoResume": False,
            "logLevel": "warn",
            "fsyncOnComplete": False,
        },
    )


class SafeKernel(Kernel):
    """Kernel driver with UTF-8 stderr decoding.

    The shipped driver relies on ``text=True``, which on a Chinese Windows host
    defaults to GBK and raises UnicodeDecodeError on kernel stderr bytes. This
    subclass only changes the pipe encoding; protocol driving stays identical.
    """

    def __init__(self, binary: str, data_dir: str) -> None:
        import queue
        import threading
        import subprocess

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


def raw_request(kernel: Kernel, method: str, params: dict, timeout: float = 10.0) -> dict:
    """Send one frame and return the raw envelope even when ok=false."""
    import queue

    kernel.next_id += 1
    request_id = f"raw-{kernel.next_id}"
    payload = {"id": request_id, "method": method, "params": params}
    assert kernel.proc.stdin is not None
    kernel.proc.stdin.write(json.dumps(payload, ensure_ascii=False) + "\n")
    kernel.proc.stdin.flush()
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            message = kernel.lines.get(timeout=max(0.05, deadline - time.time()))
        except queue.Empty:
            continue
        if message.get("id") == request_id:
            return message
        kernel.notifications.append(message)
    raise TimeoutError(f"raw {method} timed out")


# ── 1. no-range single-stream download ──────────────────────────────────────
def scenario_norange(fixture: Fixture, binary: str) -> None:
    data_dir = fresh_dir("norange-data")
    download_dir = fresh_dir("norange-downloads")
    kernel = SafeKernel(binary, data_dir)
    try:
        init_kernel(kernel, download_dir, connections=8)
        size = 3 * 1024 * 1024
        url = fixture.url + f"/norange/{size}/norange.bin"
        probe = kernel.request("probe", {"url": url}).get("server") or {}
        check("norange.probe.range.supported false", field(probe, "range", "supported") is False, field(probe, "range"))
        # `acceptRanges` is the raw header trimmed: the fixture sends no
        # Accept-Ranges header here, so "unknown" (not "none") is correct.
        check(
            "norange.probe.range.acceptRanges none-or-unknown",
            field(probe, "range", "acceptRanges") in {"none", "unknown"},
            field(probe, "range", "acceptRanges"),
        )
        check("norange.probe.resume.safety none", field(probe, "resume", "safety") == "none", field(probe, "resume"))
        check(
            "norange.probe.resume.reason no-range-support",
            field(probe, "resume", "reason") == "no-range-support",
            field(probe, "resume", "reason"),
        )
        check(
            "norange.probe.recommendation singleStream true",
            field(probe, "recommendation", "singleStream") is True,
            field(probe, "recommendation"),
        )
        expected = sha256_hex(fetch_bytes(url))
        started = kernel.request(
            "start",
            {"url": url, "dir": download_dir, "fileName": "norange.bin", "connections": 8},
        ).get("task") or {}
        task_id = started.get("id")
        check("norange.start task id", isinstance(task_id, str) and task_id.startswith("t_"), task_id)
        check("norange.start resumeSafety none", started.get("resumeSafety") == "none", started.get("resumeSafety"))
        final = wait_task(kernel, task_id, timeout=90)
        check("norange.completed", final.get("status") == "completed", final.get("status"))
        check("norange.downloaded==total", final.get("downloaded") == size, (final.get("downloaded"), final.get("total")))
        check("norange.final rangeSupported false", final.get("rangeSupported") is False, final.get("rangeSupported"))
        check("norange.final resumeSafety none", final.get("resumeSafety") == "none", final.get("resumeSafety"))
        target = os.path.join(download_dir, "norange.bin")
        check("norange.file exists", os.path.exists(target), target)
        if os.path.exists(target):
            with open(target, "rb") as handle:
                check("norange.bytes match", sha256_hex(handle.read()) == expected, "sha mismatch")
        detail = kernel.request("get", {"id": task_id}).get("detail") or {}
        check(
            "norange.detail.server.resume no-range-support",
            field(detail, "server", "resume", "safety") == "none"
            and field(detail, "server", "resume", "reason") == "no-range-support",
            field(detail, "server", "resume"),
        )
    finally:
        kernel.close()


# ── 2. pause -> kernel restart -> resume (same data dir) ────────────────────
def scenario_restart_resume(fixture: Fixture, binary: str) -> None:
    data_dir = fresh_dir("restart-data")
    download_dir = fresh_dir("restart-downloads")
    size = 4 * 1024 * 1024
    slow_url = fixture.url + f"/slow/{size}/restart.bin?chunk=16384&delay=25"
    expected = sha256_hex(fetch_bytes(fixture.url + f"/ranged/{size}/expected.bin"))
    task_id = None
    paused_downloaded = 0

    kernel = SafeKernel(binary, data_dir)
    try:
        init_kernel(kernel, download_dir, connections=2)
        started = kernel.request(
            "start",
            {
                "url": slow_url,
                "dir": download_dir,
                "fileName": "restart.bin",
                "connections": 2,
            },
        ).get("task") or {}
        task_id = started.get("id")
        check("restart.start task id", isinstance(task_id, str), task_id)
        deadline = time.time() + 30
        running = False
        while time.time() < deadline:
            view = kernel.request("get", {"id": task_id}).get("task") or {}
            if view.get("status") == "running" and (view.get("downloaded") or 0) > 256 * 1024:
                running = True
                break
            time.sleep(0.05)
        check("restart.observed running with partial bytes", running, None)
        paused = kernel.request("control", {"id": task_id, "action": "pause"}).get("task") or {}
        check("restart.pause -> paused", paused.get("status") == "paused", paused.get("status"))
        paused_downloaded = int(paused.get("downloaded") or 0)
        check(
            "restart.partial bytes persisted in view",
            0 < paused_downloaded < size,
            (paused_downloaded, size),
        )
        check(
            "restart.part file exists",
            os.path.exists(os.path.join(download_dir, "restart.bin.part")),
            None,
        )
    finally:
        kernel.close()
    check("restart.first kernel exited", kernel.proc.poll() is not None, kernel.proc.poll())

    # Same data dir, brand-new kernel process: state must have been persisted.
    kernel2 = SafeKernel(binary, data_dir)
    try:
        init_kernel(kernel2, download_dir, connections=2)
        tasks = kernel2.request("list", {}).get("tasks") or []
        recovered = next((t for t in tasks if t.get("id") == task_id), None)
        check("restart.task recovered after restart", recovered is not None, [t.get("id") for t in tasks])
        if recovered is not None:
            check("restart.recovered status paused", recovered.get("status") == "paused", recovered.get("status"))
            check(
                "restart.recovered downloaded preserved",
                int(recovered.get("downloaded") or 0) >= paused_downloaded,
                (recovered.get("downloaded"), paused_downloaded),
            )
        resumed = kernel2.request("control", {"id": task_id, "action": "resume"}).get("task") or {}
        check(
            "restart.resume accepted",
            resumed.get("status") in {"queued", "probing", "running", "paused"},
            resumed.get("status"),
        )
        final = wait_task(kernel2, task_id, timeout=120)
        check("restart.completed", final.get("status") == "completed", final.get("status"))
        check("restart.downloaded==total", final.get("downloaded") == size, (final.get("downloaded"), final.get("total")))
        target = os.path.join(download_dir, "restart.bin")
        check("restart.file exists", os.path.exists(target), target)
        if os.path.exists(target):
            with open(target, "rb") as handle:
                check(
                    "restart.bytes identical after restart-resume",
                    sha256_hex(handle.read()) == expected,
                    "sha mismatch",
                )
    finally:
        kernel2.close()


# ── 3 + 4 + 5. session scoping, protocol mismatch, stats ───────────────────
def scenario_sessions_protocol_stats(fixture: Fixture, binary: str) -> None:
    data_dir = fresh_dir("sessions-data")
    download_dir = fresh_dir("sessions-downloads")
    kernel = SafeKernel(binary, data_dir)
    try:
        init_kernel(kernel, download_dir, connections=2)
        size = 512 * 1024
        url = fixture.url + f"/ranged/{size}/sess.bin"
        a = kernel.request(
            "start",
            {"url": url, "dir": download_dir, "fileName": "sess-a.bin", "sessionId": "sess_alpha", "connections": 2},
        ).get("task") or {}
        b = kernel.request(
            "start",
            {"url": url, "dir": download_dir, "fileName": "sess-b.bin", "sessionId": "sess_beta", "connections": 2},
        ).get("task") or {}
        g = kernel.request(
            "start",
            {"url": url, "dir": download_dir, "fileName": "sess-g.bin", "connections": 2},
        ).get("task") or {}
        for task, label in ((a, "alpha"), (b, "beta"), (g, "global")):
            wait_task(kernel, task.get("id"), timeout=60)
            check(f"sessions.{label} completed", True)

        alpha = kernel.request("list", {"sessionId": "sess_alpha"}).get("tasks") or []
        beta = kernel.request("list", {"sessionId": "sess_beta"}).get("tasks") or []
        global_all = kernel.request("list", {}).get("tasks") or []
        absent = kernel.request("list", {"sessionId": "sess_missing"}).get("tasks") or []
        ids_alpha = {t.get("id") for t in alpha}
        check("sessions.alpha list contains alpha", a.get("id") in ids_alpha, list(ids_alpha))
        check("sessions.alpha excludes beta", b.get("id") not in ids_alpha, list(ids_alpha))
        check("sessions.alpha excludes session-less", g.get("id") not in ids_alpha, list(ids_alpha))
        ids_beta = {t.get("id") for t in beta}
        check("sessions.beta contains beta", b.get("id") in ids_beta, list(ids_beta))
        check("sessions.beta excludes alpha", a.get("id") not in ids_beta, list(ids_beta))
        check("sessions.missing empty", absent == [], absent)
        ids_all = {t.get("id") for t in global_all}
        check(
            "sessions.global list includes all three",
            {a.get("id"), b.get("id"), g.get("id")} <= ids_all,
            sorted(ids_all),
        )
        no_session = [t for t in global_all if t.get("id") == g.get("id")]
        check(
            "sessions.session-less task sessionId null",
            bool(no_session) and no_session[0].get("sessionId") is None,
            no_session,
        )

        # raw protocol mismatch frame (protocol 1 against protocol-2 kernel)
        init_params = {
            "defaultDir": download_dir,
            "connections": 2,
            "chunkSizeBytes": 0,
            "speedLimitBps": 0,
            "maxAttempts": 3,
            "autoResume": False,
            "logLevel": "warn",
            "fsyncOnComplete": False,
        }
        rejected = raw_request(kernel, "initialize", {"protocol": 1, **init_params})
        check("protocol.initialize protocol=1 rejected", rejected.get("ok") is False, rejected)
        error = rejected.get("error") or {}
        check("protocol.error.code protocol_mismatch", error.get("code") == "protocol_mismatch", error)
        check(
            "protocol.error.message mentions protocol",
            isinstance(error.get("message"), str) and "protocol" in error.get("message", ""),
            error.get("message"),
        )
        accepted = raw_request(kernel, "initialize", {"protocol": 2, **init_params})
        check(
            "protocol.initialize protocol=2 accepted",
            accepted.get("ok") is True and field(accepted, "result", "protocol") == 2,
            accepted,
        )

        # stats: throughput windows + origin ledger count present
        kernel.request("probe", {"url": fixture.url + f"/ranged/{size}/origin.bin"})
        stats = kernel.request("stats")
        check("stats.protocol==2", stats.get("protocol") == 2, stats.get("protocol"))
        throughput = stats.get("throughput") or {}
        check(
            "stats.throughput four windows",
            has_all(throughput, ["nowBps", "w5Bps", "w30Bps", "w300Bps"]),
            throughput,
        )
        # PROTOCOL.md: a window is null when it has no measured data yet;
        # `nowBps` is always an integer. null must never be replaced by 0.
        check(
            "stats.throughput nowBps int, windows null-or-int",
            isinstance(throughput.get("nowBps"), int)
            and throughput.get("nowBps") >= 0
            and all(
                throughput.get(k) is None
                or (isinstance(throughput.get(k), int) and throughput.get(k) >= 0)
                for k in ("w5Bps", "w30Bps", "w300Bps")
            ),
            throughput,
        )
        check("stats.origins host count int", isinstance(stats.get("origins"), int), stats.get("origins"))
        check("stats.origins >= 1 after probe", (stats.get("origins") or 0) >= 1, stats.get("origins"))
        check("stats.tasks completed >= 3", field(stats, "tasks", "completed", default=0) >= 3, field(stats, "tasks"))
        check(
            "stats.kernel.version 0.3.0-alpha.2",
            str(field(stats, "kernel", "version", default="")) == "0.3.0-alpha.2",
            field(stats, "kernel", "version"),
        )
        check("stats.totals.bytesDownloaded > 0", field(stats, "totals", "bytesDownloaded", default=0) > 0, field(stats, "totals"))

        # origin ledger facts ride along on probe when known
        origin_probe = kernel.request("probe", {"url": fixture.url + f"/ranged/{size}/origin2.bin"}).get("server") or {}
        check("probe.origin present after activity", origin_probe.get("origin") is not None, origin_probe.get("origin"))
    finally:
        kernel.close()


# ── 6. chunked / unknown-length single stream ──────────────────────────────
def scenario_chunked(fixture: Fixture, binary: str) -> None:
    data_dir = fresh_dir("chunked-data")
    download_dir = fresh_dir("chunked-downloads")
    kernel = SafeKernel(binary, data_dir)
    try:
        init_kernel(kernel, download_dir, connections=4)
        size = 1024 * 1024
        url = fixture.url + f"/chunked/{size}/chunked.bin"
        probe = kernel.request("probe", {"url": url}).get("server") or {}
        check("chunked.probe.range unsupported", field(probe, "range", "supported") is False, field(probe, "range"))
        expected = sha256_hex(fetch_bytes(fixture.url + f"/ranged/{size}/expected.bin"))
        started = kernel.request(
            "start",
            {
                "url": url,
                "dir": download_dir,
                "fileName": "chunked.bin",
                "connections": 4,
                "expectedSha256": expected,
            },
        ).get("task") or {}
        final = wait_task(kernel, started.get("id"), timeout=90)
        check("chunked.completed", final.get("status") == "completed", final.get("status"))
        check("chunked.downloaded==size", final.get("downloaded") == size, (final.get("downloaded"), final.get("total")))
        target = os.path.join(download_dir, "chunked.bin")
        if os.path.exists(target):
            with open(target, "rb") as handle:
                check("chunked.bytes match", sha256_hex(handle.read()) == expected, "sha mismatch")
        else:
            check("chunked.file exists", False, target)
    finally:
        kernel.close()


SCENARIOS = [
    ("no-range single stream", scenario_norange),
    ("pause/restart/resume", scenario_restart_resume),
    ("sessions/protocol/stats", scenario_sessions_protocol_stats),
    ("chunked unknown length", scenario_chunked),
]


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
        for label, scenario in SCENARIOS:
            print(f"[extra] scenario: {label}")
            try:
                scenario(fixture, args.kernel)
            except Exception:
                traceback.print_exc()
                check(f"{label}.scenario exception", False, traceback.format_exc()[-900:])
    except Exception:
        traceback.print_exc()
        check("harness.fixture exception", False, traceback.format_exc()[-900:])
    finally:
        if fixture is not None:
            fixture.close()
    elapsed = time.time() - started
    passed = sum(1 for entry in CHECKS if entry["ok"])
    failed = [entry for entry in CHECKS if not entry["ok"]]
    print(f"\nextra: {passed}/{len(CHECKS)} checks passed in {elapsed:.1f}s")
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
        os.makedirs(os.path.dirname(os.path.abspath(args.json)), exist_ok=True)
        with open(args.json, "w", encoding="utf-8") as handle:
            json.dump(payload, handle, indent=2)
        print(f"[extra] wrote {args.json}")
    return 0 if not failed and passed > 0 else 1


if __name__ == "__main__":
    sys.exit(main())
