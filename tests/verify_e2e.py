#!/usr/bin/env python3
"""Out-of-process end-to-end driver for the dsh-rdm kernel (protocol 2).

Why Python: inside the DSH agent sandbox a Node process cannot spawn children
(child_process => EPERM), so tests/kernel-e2e.mjs cannot run there. Python's
subprocess can, so this harness spawns the real kernel binary plus the Node
fixture server and drives the NDJSON protocol exactly like the host plugin.

Run: python tests/verify_e2e.py [--kernel path] [--json out.json]
Exit code 0 = all checks pass.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import queue
import shutil
import subprocess
import sys
import threading
import time
import traceback
import urllib.parse

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TMP_ROOT = os.path.join(ROOT, "tests", ".tmp-e2e-py")
TERMINAL = {"completed", "failed", "cancelled"}
KERNEL_NAME = "rdm-kernel.exe" if os.name == "nt" else "rdm-kernel"

CHECKS: list[dict] = []


def check(name: str, ok: bool, detail=None) -> bool:
    entry = {"name": name, "ok": bool(ok)}
    if not ok:
        entry["detail"] = detail if isinstance(detail, (str, int, float, type(None))) else repr(detail)[:600]
        print(f"  FAIL {name}: {entry['detail']}")
    CHECKS.append(entry)
    return bool(ok)


def require(condition, name: str, detail=None) -> None:
    if not check(name, condition, detail):
        raise AssertionError(name)


def platform_kernel() -> str:
    plat = {"win32": "win32", "linux": "linux", "darwin": "darwin"}.get(sys.platform, sys.platform)
    arch = {"AMD64": "x64", "x86_64": "x64", "arm64": "arm64", "aarch64": "arm64"}.get(os.environ.get("PROCESSOR_ARCHITECTURE", ""), "x64")
    return os.path.join(ROOT, "bin", f"{plat}-{arch}", KERNEL_NAME)


class Fixture:
    def __init__(self) -> None:
        self.proc = subprocess.Popen(
            ["node", os.path.join(ROOT, "tests", "fixture-launcher.mjs")],
            cwd=ROOT,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            errors="replace",
            bufsize=1,
        )
        line = self.proc.stdout.readline()
        if not line:
            err = self.proc.stderr.read() if self.proc.stderr else ""
            raise RuntimeError(f"fixture launcher produced no URL: {err[-800:]}")
        info = json.loads(line)
        self.url = info["url"]
        self.port = info["port"]

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


class Kernel:
    def __init__(self, binary: str, data_dir: str) -> None:
        self.lines: queue.Queue = queue.Queue()
        self.stderr_lines: list[str] = []
        self.proc = subprocess.Popen(
            [binary, "--data-dir", data_dir, "--log-level", "warn"],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            errors="replace",
            bufsize=1,
        )
        threading.Thread(target=self._pump_stdout, daemon=True).start()
        threading.Thread(target=self._pump_stderr, daemon=True).start()
        self.next_id = 0
        self.ready = self._await_event("ready", timeout=20.0)
        self.notifications: list[dict] = []

    def _pump_stdout(self) -> None:
        assert self.proc.stdout is not None
        for line in self.proc.stdout:
            line = line.strip()
            if not line:
                continue
            try:
                self.lines.put(json.loads(line))
            except json.JSONDecodeError:
                self.lines.put({"event": "unparsable", "raw": line[:400]})

    def _pump_stderr(self) -> None:
        assert self.proc.stderr is not None
        for line in self.proc.stderr:
            self.stderr_lines.append(line.rstrip())
            if len(self.stderr_lines) > 200:
                del self.stderr_lines[0]

    def _await_event(self, event: str, timeout: float) -> dict:
        deadline = time.time() + timeout
        while time.time() < deadline:
            remaining = max(0.05, deadline - time.time())
            try:
                message = self.lines.get(timeout=remaining)
            except queue.Empty:
                continue
            if message.get("event") == event:
                return message
            self.notifications.append(message)
        raise TimeoutError(f"event {event!r} not observed; stderr tail={self.stderr_lines[-5:]}")

    def request(self, method: str, params: dict | None = None, timeout: float = 30.0) -> dict:
        self.next_id += 1
        request_id = f"req-{self.next_id}"
        payload = {"id": request_id, "method": method, "params": params or {}}
        assert self.proc.stdin is not None
        self.proc.stdin.write(json.dumps(payload, ensure_ascii=False) + "\n")
        self.proc.stdin.flush()
        deadline = time.time() + timeout
        while time.time() < deadline:
            remaining = max(0.05, deadline - time.time())
            try:
                message = self.lines.get(timeout=remaining)
            except queue.Empty:
                continue
            if message.get("id") == request_id:
                if not message.get("ok"):
                    raise RuntimeError(f"{method} failed: {message.get('error')}")
                return message.get("result") or {}
            self.notifications.append(message)
        raise TimeoutError(f"{method} timed out after {timeout}s; stderr tail={self.stderr_lines[-5:]}")

    def close(self) -> None:
        if self.proc.poll() is None:
            try:
                self.proc.stdin.close()  # type: ignore[union-attr]
            except Exception:
                pass
            try:
                self.proc.wait(timeout=6)
            except subprocess.TimeoutExpired:
                self.proc.kill()


def wait_task(kernel: Kernel, task_id: str, timeout: float = 60.0) -> dict:
    result = kernel.request("wait", {"ids": [task_id], "timeoutMs": int(timeout * 1000)}, timeout=timeout + 10)
    tasks = result.get("tasks") or []
    if not tasks:
        raise RuntimeError(f"wait returned no task for {task_id}")
    return tasks[0]


def fetch_bytes(url: str) -> bytes:
    import urllib.request

    with urllib.request.urlopen(url, timeout=30) as response:  # noqa: S310 - local fixture
        return response.read()


def sha256_hex(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def field(obj, *path, default=None):
    current = obj
    for key in path:
        if not isinstance(current, dict) or key not in current:
            return default
        current = current[key]
    return current


def has_all(obj: dict, keys: list[str]) -> bool:
    return all(key in obj for key in keys)


def scenario(fixture: Fixture, binary: str) -> None:
    data_dir = os.path.join(TMP_ROOT, "kernel-data")
    download_dir = os.path.join(TMP_ROOT, "downloads")
    shutil.rmtree(data_dir, ignore_errors=True)
    shutil.rmtree(download_dir, ignore_errors=True)
    os.makedirs(data_dir, exist_ok=True)
    os.makedirs(download_dir, exist_ok=True)

    kernel = Kernel(binary, data_dir)
    try:
        # ── lifecycle + protocol pin ─────────────────────────────────────
        check("ready.protocol==2", field(kernel.ready, "protocol") == 2, kernel.ready)
        version = str(field(kernel.ready, "kernel", "version", default=""))
        check("ready.kernel.version 1.1", version.startswith("1.1."), version)
        init = kernel.request("initialize", {
            "defaultDir": download_dir,
            "connections": 4,
            "chunkSizeBytes": 0,
            "speedLimitBps": 0,
            "maxAttempts": 3,
            "autoResume": True,
            "logLevel": "warn",
            "fsyncOnComplete": False,
        })
        check("initialize.protocol==2", init.get("protocol") == 2, init.get("protocol"))

        # ── probe: ranged server facts ───────────────────────────────────
        size = 4 * 1024 * 1024
        url = fixture.url + f"/ranged/{size}/probe.bin"
        probe = kernel.request("probe", {"url": url}).get("server") or {}
        check("probe.server fields", has_all(probe, [
            "url", "finalUrl", "host", "status", "fileName", "fileNameSource", "totalBytes",
            "contentType", "range", "validators", "resume", "signedUrl", "tls", "redirects",
            "headers", "rateLimit", "timing", "checksum", "warnings", "recommendation", "origin",
        ]), sorted(probe.keys()))
        check("probe.totalBytes", probe.get("totalBytes") == size, probe.get("totalBytes"))
        check("probe.range.supported", field(probe, "range", "supported") is True, field(probe, "range"))
        check("probe.range.acceptRanges bytes", field(probe, "range", "acceptRanges") == "bytes", field(probe, "range", "acceptRanges"))
        check("probe.validators.etag present", field(probe, "validators", "etag"), field(probe, "validators"))
        check("probe.resume.safety strong", field(probe, "resume", "safety") == "strong", field(probe, "resume"))
        check("probe.recommendation singleStream false", field(probe, "recommendation", "singleStream") is False, field(probe, "recommendation"))
        check("probe.timing.probeMs integer", isinstance(field(probe, "timing", "probeMs"), int), field(probe, "timing"))
        check("probe.warnings list", isinstance(probe.get("warnings"), list), probe.get("warnings"))
        check("probe.redirects list", isinstance(probe.get("redirects"), list), probe.get("redirects"))
        check("probe.tls null on http", probe.get("tls") is None, probe.get("tls"))
        check("probe.host", probe.get("host") == "127.0.0.1", probe.get("host"))

        # ── probe: redirect chain ───────────────────────────────────────
        redirect_url = fixture.url + f"/redirect/{1024}/redir.bin"
        redirect_probe = kernel.request("probe", {"url": redirect_url}).get("server") or {}
        redirects = redirect_probe.get("redirects") or []
        check("probe.redirect chain recorded", len(redirects) >= 2, redirects)
        check("probe.redirect final status", redirect_probe.get("status") == 200, redirect_probe.get("status"))
        check("probe.redirect warning", "redirected" in (redirect_probe.get("warnings") or []), redirect_probe.get("warnings"))

        # ── probe: signed-URL expiry (AWS SigV4 style) ───────────────────
        date = time.strftime("%Y%m%dT%H%M%SZ", time.gmtime(time.time() - 60))
        signed_url = url + f"?X-Amz-Date={date}&X-Amz-Expires=3600&X-Amz-Signature=deadbeef"
        signed = kernel.request("probe", {"url": signed_url}).get("server") or {}
        signed_facts = signed.get("signedUrl") or {}
        check("probe.signedUrl detected", signed_facts.get("signed") is True, signed_facts)
        check("probe.signedUrl source", signed_facts.get("source") == "aws-sigv4", signed_facts.get("source"))
        check("probe.signedUrl valid", signed_facts.get("state") == "valid", signed_facts.get("state"))
        expires_at = signed_facts.get("expiresAt")
        check("probe.signedUrl expiresAt future", isinstance(expires_at, int) and expires_at > time.time() * 1000, expires_at)

        old_date = time.strftime("%Y%m%dT%H%M%SZ", time.gmtime(time.time() - 7200))
        expired_url = url + f"?X-Amz-Date={old_date}&X-Amz-Expires=60&X-Amz-Signature=deadbeef"
        expired = kernel.request("probe", {"url": expired_url}).get("server") or {}
        check("probe.expired signedUrl state", field(expired, "signedUrl", "state") == "expired", field(expired, "signedUrl"))
        check("probe.expired warning", "signed-url-expired" in (expired.get("warnings") or []), expired.get("warnings"))

        # ── start + preflight facts + completion ─────────────────────────
        expected = sha256_hex(fetch_bytes(url))
        started = kernel.request("start", {
            "url": url,
            "dir": download_dir,
            "fileName": "download.bin",
            "connections": 4,
            "expectedSha256": expected,
            "sessionId": "sess_e2e",
        }).get("task") or {}
        task_id = started.get("id")
        check("start.task id", isinstance(task_id, str) and task_id.startswith("t_"), task_id)
        check("start.sessionId round-trip", started.get("sessionId") == "sess_e2e", started.get("sessionId"))
        check("start.taskView v2 fields", has_all(started, [
            "sessionId", "host", "percent", "avgBps", "peakBps", "etaConfidence", "stalledMs",
            "resumable", "resumeSafety", "verified", "signedUrlExpiresAt", "tlsNotAfter",
        ]), sorted(started.keys()))

        live = kernel.request("get", {"id": task_id}).get("task") or {}
        detail = kernel.request("get", {"id": task_id}).get("detail") or {}
        check("get detail telemetry windows", isinstance(field(detail, "telemetry", "windows"), dict), field(detail, "telemetry"))
        if field(detail, "server"):
            check("detail.server RangeFacts after probe", field(detail, "server", "range", "supported") is True, field(detail, "server", "range"))

        final = wait_task(kernel, task_id, timeout=90)
        check("wait.completed", final.get("status") == "completed", final.get("status"), )
        check("wait.downloaded==total", final.get("downloaded") == size, (final.get("downloaded"), final.get("total")))
        check("wait.percent 100", final.get("percent") == 100, final.get("percent"))
        check("wait.verified true", final.get("verified") is True, (final.get("verified"), final.get("sha256")))
        target = os.path.join(download_dir, "download.bin")
        check("file exists", os.path.exists(target), target)
        if os.path.exists(target):
            with open(target, "rb") as handle:
                check("file bytes match", sha256_hex(handle.read()) == expected, "sha mismatch")
        terminal_detail = kernel.request("get", {"id": task_id}).get("detail") or {}
        check("detail.server retained", isinstance(terminal_detail.get("server"), dict), type(terminal_detail.get("server")))
        check("detail.verification.verified", field(terminal_detail, "verification", "verified") is True, field(terminal_detail, "verification"))
        check("detail.diagnosis list", isinstance(terminal_detail.get("diagnosis"), list), terminal_detail.get("diagnosis"))
        check("detail.target.path", field(terminal_detail, "target", "path") == target, field(terminal_detail, "target", "path"))

        # ── list + session scoping + aggregate ───────────────────────────
        scoped = kernel.request("list", {"sessionId": "sess_e2e"}).get("tasks") or []
        check("list.sessionId returns task", any(t.get("id") == task_id for t in scoped), [t.get("id") for t in scoped])
        other = kernel.request("list", {"sessionId": "sess_other"}).get("tasks") or []
        check("list.sessionId excludes other sessions", all(t.get("id") != task_id for t in other), [t.get("id") for t in other])
        aggregate = kernel.request("list", {"sessionId": "sess_e2e"}).get("aggregate") or {}
        check("list.aggregate fields", has_all(aggregate, ["total", "active", "completed", "failed", "bytesDownloaded", "nowBps", "w5Bps", "w30Bps", "w300Bps", "riskCount"]), sorted(aggregate.keys()))
        check("list.aggregate counts", aggregate.get("completed", 0) >= 1 and aggregate.get("total", 0) >= 1, aggregate)

        # ── stats ───────────────────────────────────────────────────────
        stats = kernel.request("stats")
        check("stats.protocol==2", stats.get("protocol") == 2, stats.get("protocol"))
        check("stats.throughput fields", has_all(stats.get("throughput") or {}, ["nowBps", "w5Bps", "w30Bps", "w300Bps"]), stats.get("throughput"))
        check("stats.origins int", isinstance(stats.get("origins"), int), stats.get("origins"))
        check("stats.tasks counts", field(stats, "tasks", "completed", default=0) >= 1, field(stats, "tasks"))

        # ── telemetry while running + pause/resume ──────────────────────
        slow_size = 2 * 1024 * 1024
        slow_url = fixture.url + f"/slow/{slow_size}/slow.bin?chunk=16384&delay=20"
        slow = kernel.request("start", {"url": slow_url, "dir": download_dir, "fileName": "slow.bin", "connections": 2, "sessionId": "sess_e2e"}).get("task") or {}
        slow_id = slow.get("id")
        observed_running = False
        sampled_detail = None
        deadline = time.time() + 20
        while time.time() < deadline:
            current = kernel.request("get", {"id": slow_id})
            view = current.get("task") or {}
            if view.get("status") == "running" and (view.get("downloaded") or 0) > 0:
                observed_running = True
                sampled_detail = current.get("detail")
                break
            time.sleep(0.1)
        check("running observed with progress", observed_running, None)
        if sampled_detail:
            windows = field(sampled_detail, "telemetry", "windows") or {}
            check("telemetry has 1s/5s/30s windows", all(k in windows for k in ("1s", "5s", "30s")), windows)
            check("telemetry.samples grows", field(sampled_detail, "telemetry", "samples", default=0) >= 1, field(sampled_detail, "telemetry", "samples"))
            check("telemetry.etaConfidence known", field(sampled_detail, "telemetry", "etaConfidence") in {"high", "medium", "low", "unknown"}, field(sampled_detail, "telemetry", "etaConfidence"))
        paused = kernel.request("control", {"id": slow_id, "action": "pause"}).get("task") or {}
        check("control.pause -> paused", paused.get("status") == "paused", paused.get("status"))
        resumed = kernel.request("control", {"id": slow_id, "action": "resume"}).get("task") or {}
        check("control.resume -> queued/probing/running", resumed.get("status") in {"queued", "probing", "running", "paused"}, resumed.get("status"))
        slow_final = wait_task(kernel, slow_id, timeout=90)
        check("paused download completes", slow_final.get("status") == "completed", slow_final.get("status"))

        # ── remove ──────────────────────────────────────────────────────
        removed = kernel.request("control", {"id": slow_id, "action": "remove", "deletePart": True})
        check("control.remove returns null task", removed.get("task") is None, removed.get("task"))
        after = kernel.request("list", {"sessionId": "sess_e2e"}).get("tasks") or []
        check("remove hides task", all(t.get("id") != slow_id for t in after), [t.get("id") for t in after])

    finally:
        kernel.close()


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--kernel", default=None)
    parser.add_argument("--json", default=None)
    args = parser.parse_args()
    binary = args.kernel or platform_kernel()
    os.makedirs(TMP_ROOT, exist_ok=True)
    if not os.path.exists(binary):
        print(f"kernel binary not found: {binary}", file=sys.stderr)
        return 2
    fixture = None
    started = time.time()
    try:
        fixture = Fixture()
        scenario(fixture, binary)
    except Exception:
        traceback.print_exc()
        CHECKS.append({"name": "harness.exception", "ok": False, "detail": traceback.format_exc()[-1200:]})
    finally:
        if fixture:
            fixture.close()
    passed = sum(1 for c in CHECKS if c["ok"])
    failed = [c for c in CHECKS if not c["ok"]]
    elapsed = time.time() - started
    print(f"\ne2e: {passed}/{len(CHECKS)} checks passed in {elapsed:.1f}s")
    for item in failed:
        print(f"  FAILED: {item['name']} :: {item.get('detail')}")
    if args.json:
        with open(args.json, "w", encoding="utf-8") as handle:
            json.dump({"checks": CHECKS, "passed": passed, "failed": len(failed), "elapsedSec": elapsed}, handle, indent=2)
    return 0 if not failed and passed > 0 else 1


if __name__ == "__main__":
    sys.exit(main())
