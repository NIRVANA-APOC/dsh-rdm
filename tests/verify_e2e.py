#!/usr/bin/env python3
"""Out-of-process end-to-end driver for the dsh-rdm kernel (protocol 2).

Why Python: inside the DSH agent sandbox a Node process cannot spawn children
(child_process => EPERM), so tests/kernel-e2e.mjs cannot run there. Python's
subprocess can, so this harness spawns the real kernel binary plus the Node
fixture server and drives the NDJSON protocol exactly like the host plugin.

Groups (select with --only=core,v030,v022):
  core  protocol-v2 lifecycle, probe matrix, ranged download, pause/resume,
        cancel/remove, list/stats/telemetry.
  v030  0.2.1 verification contract (frozen spec `.design/0.3.0-spec.md` §4,
        shipped as release 0.2.1): maxConnections clamp/adaptive cap,
        volatile-final-URL resume, history RPC + JSONL recording + restart
        persistence, auth_key redaction, new TaskView / resumeState fields.
  v022  0.2.2 verification contract (`.design/0.2.2-spec.md` §4): history meta
        build attribution (+ builds), effective maxConnections/plan receipt,
        this-run rate accounting on resume, target restore, unsupported_method,
        and legacy 0.2.1 histories without meta lines.

Run: python tests/verify_e2e.py [--kernel path] [--only core,v030,v022] [--json out.json]
Exit code 0 = all checks pass.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import queue
import re
import shutil
import subprocess
import sys
import threading
import time
import traceback
import urllib.parse

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
# Per-run temp root. Two harness instances (e.g. the Lead's gate run and an
# agent pre-run) must never share data/download dirs: each scenario starts with
# `shutil.rmtree(group_root)`, which would otherwise delete the other run's
# in-flight `.part` files and produce spurious `local file error: ... os error 2`.
TMP_ROOT = os.path.join(ROOT, "tests", ".tmp-e2e-py", f"run-{os.getpid()}")


def cleanup_stale_run_roots(parent: str, max_age_seconds: float = 2 * 60 * 60) -> None:
    """Drop per-run temp roots left behind by harness runs older than max_age."""
    try:
        entries = os.listdir(parent)
    except OSError:
        return
    now = time.time()
    for entry in entries:
        if not entry.startswith("run-"):
            continue
        path = os.path.join(parent, entry)
        try:
            if now - os.path.getmtime(path) > max_age_seconds:
                shutil.rmtree(path, ignore_errors=True)
        except OSError:
            continue

TERMINAL = {"completed", "failed", "cancelled"}
KERNEL_NAME = "rdm-kernel.exe" if os.name == "nt" else "rdm-kernel"

# Resume decision codes (frozen in `.design/0.3.0-spec.md` §1.5).
ACCEPTED_RESUME_REASONS = {"etag", "last-modified", "url", "file-name", "final-url"}
REJECTED_RESUME_REASONS = {
    "disabled",
    "no-state",
    "state-corrupt",
    "version-mismatch",
    "size-mismatch",
    "validators-mismatch",
    "url-mismatch",
    "file-name-mismatch",
    "ranges-invalid",
    "part-missing",
    "part-truncated",
}
RESUME_DECISIONS = {"accepted", "rejected", "not-attempted"}

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

    def health(self) -> dict:
        """Fixture constants (auth_key secret, stable etags) over HTTP."""
        return fetch_json(self.url + "/__fixture/health")

    def state(self) -> dict:
        """Live fixture counters (volatile tokens, redirect/served counts)."""
        return fetch_json(self.url + "/__fixture/state")


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

    def _write(self, method: str, params: dict | None) -> str:
        self.next_id += 1
        request_id = f"req-{self.next_id}"
        payload = {"id": request_id, "method": method, "params": params or {}}
        assert self.proc.stdin is not None
        self.proc.stdin.write(json.dumps(payload, ensure_ascii=False) + "\n")
        self.proc.stdin.flush()
        return request_id

    def _await_reply(self, request_id: str, method: str, timeout: float) -> dict:
        deadline = time.time() + timeout
        while time.time() < deadline:
            remaining = max(0.05, deadline - time.time())
            try:
                message = self.lines.get(timeout=remaining)
            except queue.Empty:
                continue
            if message.get("id") == request_id:
                return message
            self.notifications.append(message)
        raise TimeoutError(f"{method} timed out after {timeout}s; stderr tail={self.stderr_lines[-5:]}")

    def request(self, method: str, params: dict | None = None, timeout: float = 30.0) -> dict:
        """Send one RPC request; raise RuntimeError on an error response."""
        message = self._await_reply(self._write(method, params), method, timeout)
        if not message.get("ok"):
            raise RuntimeError(f"{method} failed: {message.get('error')}")
        return message.get("result") or {}

    def try_request(self, method: str, params: dict | None = None, timeout: float = 30.0) -> tuple[dict | None, dict | None]:
        """Send one RPC request; return (result, error) instead of raising."""
        message = self._await_reply(self._write(method, params), method, timeout)
        if not message.get("ok"):
            return None, message.get("error") or {}
        return message.get("result") or {}, None

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


def poll_until(fn, timeout: float, interval: float = 0.05, label: str = "condition"):
    """Poll fn() until it returns a truthy value; returns None on timeout."""
    deadline = time.time() + timeout
    last = None
    while time.time() < deadline:
        last = fn()
        if last:
            return last
        time.sleep(interval)
    return None


def task_view(kernel: Kernel, task_id: str) -> dict:
    return kernel.request("get", {"id": task_id, "events": 0}).get("task") or {}


def wait_status(kernel: Kernel, task_id: str, statuses, timeout: float = 30.0):
    def probe_view():
        view = task_view(kernel, task_id)
        return view if view.get("status") in statuses else None

    return poll_until(probe_view, timeout)


def resumed_bytes_from_plan_message(message: str) -> int:
    """Extract the resumed-bytes count from a plan event message.

    Handles the 0.2.1 wording (`N resumed bytes`) and the 0.2.2 receipt form
    (`... resumed=N bytes resume=...`).
    """
    for pattern in (
        r"resumed\s*=\s*([0-9][0-9,_]*)",
        r"([0-9][0-9,_]*)\s+resumed\s+bytes",
        r"resumed\s+bytes\s*[:=]?\s*([0-9][0-9,_]*)",
    ):
        match = re.search(pattern, message or "", re.IGNORECASE)
        if match:
            try:
                return int(match.group(1).replace(",", "").replace("_", ""))
            except ValueError:
                return 0
    return 0


def plan_message_fields(message: str) -> dict:
    """Parse the 0.2.2 plan receipt `key=value` pairs (chunks/chunk/requested/...)."""
    fields: dict[str, str] = {}
    for key in ("chunks", "chunk", "requested", "initial", "ceiling", "resumed", "resume"):
        match = re.search(rf"\b{key}\s*=\s*([^\s;]+)", message or "")
        if match:
            fields[key] = match.group(1)
    return fields



def fetch_bytes(url: str) -> bytes:
    import urllib.request

    with urllib.request.urlopen(url, timeout=30) as response:  # noqa: S310 - local fixture
        return response.read()


def fetch_json(url: str) -> dict:
    import urllib.request

    with urllib.request.urlopen(url, timeout=30) as response:  # noqa: S310 - local fixture
        return json.loads(response.read().decode("utf-8"))


def sha256_hex(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def sha256_file(path: str) -> str | None:
    try:
        with open(path, "rb") as handle:
            return sha256_hex(handle.read())
    except OSError:
        return None


def file_size(path: str) -> int | None:
    try:
        return os.path.getsize(path)
    except OSError:
        return None


def read_jsonl(path: str) -> list[dict]:
    records: list[dict] = []
    try:
        with open(path, "r", encoding="utf-8") as handle:
            for line in handle:
                line = line.strip()
                if line:
                    records.append(json.loads(line))
    except (OSError, json.JSONDecodeError):
        return records
    return records


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
        version_parts = version.split(".")
        version_ok = (
            len(version_parts) >= 2
            and version_parts[0].isdigit()
            and version_parts[1].isdigit()
            and (int(version_parts[0]), int(version_parts[1])) >= (0, 2)
        )
        check("ready.kernel.version unified with package (>= 0.2)", version_ok, version)
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


def scenario_v030(fixture: Fixture, binary: str) -> None:
    """0.3.0 verification contract: `.design/0.3.0-spec.md` §4 checks 1-5."""
    root = os.path.join(TMP_ROOT, "v030")
    data_dir = os.path.join(root, "kernel-data")
    download_dir = os.path.join(root, "downloads")
    shutil.rmtree(root, ignore_errors=True)
    os.makedirs(data_dir, exist_ok=True)
    os.makedirs(download_dir, exist_ok=True)

    health = fixture.health()
    secret = str(health.get("authKeySecret") or "")
    require(bool(secret), "v030.fixture.health exposes authKeySecret", health)

    init_params = {
        "defaultDir": download_dir,
        "connections": 4,
        "maxConnections": 1024,
        "chunkSizeBytes": 0,
        "speedLimitBps": 0,
        "maxAttempts": 3,
        "autoResume": False,
        "logLevel": "warn",
        "fsyncOnComplete": False,
    }

    kernel = Kernel(binary, data_dir)
    try:
        # ── 1. maxConnections: initialize clamp + per-task adaptive cap ──────
        init = kernel.request("initialize", init_params)
        config = init.get("config") or {}
        check("v030.initialize.config.maxConnections clamped to 128", config.get("maxConnections") == 128, config.get("maxConnections"))
        check("v030.initialize.config.connections", config.get("connections") == 4, config.get("connections"))

        def run_download(url: str, file_name: str, spec: dict, timeout: float = 90.0):
            started_task = kernel.request("start", {"url": url, "dir": download_dir, "fileName": file_name, **spec}).get("task") or {}
            final_task = wait_status(kernel, started_task.get("id"), TERMINAL, timeout=timeout) or {}
            return started_task, final_task

        cap_size = 4 * 1024 * 1024
        cap_started, cap_final = run_download(
            fixture.url + f"/ranged/{cap_size}/cap.bin", "cap.bin", {"connections": 8, "maxConnections": 128}
        )
        check(
            "v030.start view carries maxConnections/targetWorkers/resumedBytes",
            has_all(cap_started, ["maxConnections", "targetWorkers", "resumedBytes"]),
            sorted(cap_started.keys()),
        )
        check("v030.start view.maxConnections honours maxConnections=128", cap_started.get("maxConnections") == 128, cap_started.get("maxConnections"))
        check("v030.start view.connections = planned workers 8", cap_started.get("connections") == 8, cap_started.get("connections"))
        check("v030.maxConnections task completed", cap_final.get("status") == "completed", (cap_final.get("status"), cap_final.get("error")))
        cap_events = kernel.request("get", {"id": cap_started.get("id"), "events": 50}).get("events") or []
        plan_events = [event for event in cap_events if event.get("kind") == "plan"]
        check("v030.plan event recorded", len(plan_events) >= 1, [event.get("kind") for event in cap_events])
        plan_message = str((plan_events[0].get("message") if plan_events else "") or "")
        check(
            "v030.plan event reports the requested workers",
            re.search(r"requested\s*=\s*8\b", plan_message) is not None
            or re.search(r"\b8\s+workers\b", plan_message) is not None,
            plan_message,
        )

        upper_started, _ = run_download(
            fixture.url + f"/ranged/{128 * 1024}/cap-upper.bin", "cap-upper.bin", {"connections": 4, "maxConnections": 4096}
        )
        check("v030.start maxConnections clamps 4096 down to 128", upper_started.get("maxConnections") == 128, upper_started.get("maxConnections"))
        lower_started, _ = run_download(
            fixture.url + f"/ranged/{128 * 1024}/cap-lower.bin", "cap-lower.bin", {"connections": 8, "maxConnections": 2}
        )
        check("v030.start maxConnections clamps up to connections (8)", lower_started.get("maxConnections") == 8, lower_started.get("maxConnections"))
        single_started, _ = run_download(
            fixture.url + f"/ranged/{128 * 1024}/cap-single.bin",
            "cap-single.bin",
            {"connections": 8, "maxConnections": 128, "singleStream": True},
        )
        check("v030.singleStream forces connections=1", single_started.get("connections") == 1, single_started.get("connections"))
        check("v030.singleStream forces maxConnections=1", single_started.get("maxConnections") == 1, single_started.get("maxConnections"))

        # ── 2. auth_key redaction + signed-URL detection ─────────────────────
        auth_size = 512 * 1024
        auth_url = fixture.url + f"/authkey/{auth_size}/auth-secret.bin"
        auth_expected = sha256_hex(fetch_bytes(auth_url))
        auth_server = kernel.request("probe", {"url": auth_url}).get("server") or {}
        auth_final_url = str(auth_server.get("finalUrl") or "")
        check(
            "v030.authKey probe finalUrl contains auth_key=<redacted>",
            "auth_key=" in auth_final_url and "<redacted>" in auth_final_url and secret not in auth_final_url,
            auth_final_url,
        )
        hop_urls = [str(hop.get("url") or "") for hop in (auth_server.get("redirects") or [])]
        check("v030.authKey probe recorded a redirect hop", len(hop_urls) >= 1, hop_urls)
        check(
            "v030.authKey redirect hop URLs are redacted",
            all(secret not in url for url in hop_urls) and any("auth_key=" in url and "<redacted>" in url for url in hop_urls),
            hop_urls,
        )
        check(
            "v030.authKey probe projection leaks no secret",
            secret not in json.dumps(auth_server, ensure_ascii=False),
            "secret leaked in probe result",
        )
        check("v030.authKey signedUrl.signed true", field(auth_server, "signedUrl", "signed") is True, field(auth_server, "signedUrl"))

        auth_started, auth_final = run_download(auth_url, "auth-secret.bin", {"connections": 2, "maxConnections": 8})
        check("v030.authKey download completed", auth_final.get("status") == "completed", (auth_final.get("status"), auth_final.get("error")))
        auth_file = os.path.join(download_dir, "auth-secret.bin")
        check("v030.authKey download bytes byte-identical", sha256_file(auth_file) == auth_expected, sha256_file(auth_file))
        auth_view_final = str(auth_final.get("finalUrl") or "")
        check(
            "v030.authKey task view finalUrl is redacted",
            "auth_key=" in auth_view_final and "<redacted>" in auth_view_final and secret not in auth_view_final,
            auth_view_final,
        )
        check(
            "v030.authKey task view leaks no secret",
            secret not in json.dumps(auth_final, ensure_ascii=False),
            "secret leaked in task view",
        )
        auth_get = kernel.request("get", {"id": auth_started.get("id"), "events": 50})
        detail_final_url = str(field(auth_get, "detail", "server", "finalUrl") or "")
        check(
            "v030.authKey detail.server.finalUrl is redacted",
            "auth_key=" in detail_final_url and "<redacted>" in detail_final_url and secret not in detail_final_url,
            detail_final_url,
        )
        check(
            "v030.authKey detail projection leaks no secret",
            secret not in json.dumps(auth_get.get("detail"), ensure_ascii=False),
            "secret leaked in task detail",
        )

        # ── 3. volatile-final-URL resume ─────────────────────────────────────
        volatile_size = 4 * 1024 * 1024
        volatile_name = "volatile.bin"
        volatile_base = fixture.url + f"/volatile/{volatile_size}/{volatile_name}"
        volatile_expected = sha256_hex(fetch_bytes(volatile_base))
        volatile_url = volatile_base + "?slow=1&chunk=16384&delayMs=15"
        volatile_tokens_before = len(((fixture.state().get("volatile") or {}).get("tokens") or []))

        first_started = kernel.request(
            "start", {"url": volatile_url, "dir": download_dir, "fileName": volatile_name, "connections": 4}
        ).get("task") or {}
        first_id = first_started.get("id")
        check("v030.volatile first task started", isinstance(first_id, str) and first_id.startswith("t_"), first_id)
        threshold = volatile_size // 4

        def progressed_view():
            view = task_view(kernel, first_id)
            if view.get("status") in {"running", "probing"} and (view.get("downloaded") or 0) >= threshold:
                return view
            return None

        progressed = poll_until(progressed_view, timeout=25.0)
        current = task_view(kernel, first_id)
        check(
            "v030.volatile first transfer reached >=25%",
            progressed is not None,
            f"downloaded={current.get('downloaded')} status={current.get('status')}",
        )
        kernel.request("control", {"id": first_id, "action": "cancel"})
        cancelled = wait_status(kernel, first_id, {"cancelled"}, timeout=20.0) or {}
        check("v030.volatile cancel -> cancelled", cancelled.get("status") == "cancelled", cancelled.get("status"))
        check(
            "v030.volatile cancelled before completion",
            (cancelled.get("downloaded") or 0) < volatile_size,
            cancelled.get("downloaded"),
        )
        part_path = os.path.join(download_dir, volatile_name + ".part")
        part_state_path = part_path + ".json"
        check("v030.volatile .part retained with data", (file_size(part_path) or 0) > 0, file_size(part_path))
        check("v030.volatile .part.json resume state retained", os.path.exists(part_state_path), part_state_path)

        second_started = kernel.request(
            "start", {"url": volatile_url, "dir": download_dir, "fileName": volatile_name, "connections": 4}
        ).get("task") or {}
        second_id = second_started.get("id")
        check("v030.volatile restart is a new task id", isinstance(second_id, str) and second_id != first_id, (first_id, second_id))
        resumed = wait_status(kernel, second_id, TERMINAL, timeout=120.0) or {}
        check("v030.volatile resumed transfer completed", resumed.get("status") == "completed", (resumed.get("status"), resumed.get("error")))
        check(
            "v030.volatile resumed downloaded == total",
            resumed.get("downloaded") == volatile_size,
            (resumed.get("downloaded"), volatile_size),
        )
        check(
            "v030.volatile final bytes byte-identical to origin",
            sha256_file(os.path.join(download_dir, volatile_name)) == volatile_expected,
            sha256_file(os.path.join(download_dir, volatile_name)),
        )
        check("v030.volatile view.resumedBytes > 0", (resumed.get("resumedBytes") or 0) > 0, resumed.get("resumedBytes"))
        check("v030.volatile view.resumedChunks > 0", (resumed.get("resumedChunks") or 0) > 0, resumed.get("resumedChunks"))
        volatile_get = kernel.request("get", {"id": second_id, "events": 200})
        resume_state = field(volatile_get, "detail", "resumeState") or {}
        check(
            "v030.volatile detail.resumeState has decision fields",
            has_all(
                resume_state,
                ["chunksDone", "bytesDone", "resumedChunks", "resumedBytes", "validatorsMatched", "resumeDecision", "resumeReason"],
            ),
            sorted(resume_state.keys()),
        )
        check("v030.volatile resumeDecision accepted", resume_state.get("resumeDecision") == "accepted", resume_state.get("resumeDecision"))
        check(
            "v030.volatile resumeReason is an accepted code",
            resume_state.get("resumeReason") in ACCEPTED_RESUME_REASONS,
            resume_state.get("resumeReason"),
        )
        check("v030.volatile resumeState.resumedBytes > 0", (resume_state.get("resumedBytes") or 0) > 0, resume_state.get("resumedBytes"))
        check(
            "v030.volatile resumeState.validatorsMatched true",
            resume_state.get("validatorsMatched") is True,
            resume_state.get("validatorsMatched"),
        )
        plan_messages = [
            str(event.get("message") or "")
            for event in (volatile_get.get("events") or [])
            if event.get("kind") == "plan"
        ]
        plan_resumed = max([resumed_bytes_from_plan_message(message) for message in plan_messages] + [0])
        check("v030.volatile plan event reports resumed bytes > 0", plan_resumed > 0, plan_messages)
        volatile_state = fixture.state().get("volatile") or {}
        volatile_tokens_after = len(volatile_state.get("tokens") or [])
        check(
            "v030.volatile fixture minted fresh final-URL tokens",
            volatile_tokens_after > volatile_tokens_before and (volatile_state.get("uniqueTokens") or 0) >= 2,
            {"before": volatile_tokens_before, "after": volatile_tokens_after, "unique": volatile_state.get("uniqueTokens")},
        )

        # ── 4. history RPC + JSONL recording ────────────────────────────────
        hist_size = 1024 * 1024
        hist_name = "history.bin"
        hist_expected = sha256_hex(fetch_bytes(fixture.url + f"/ranged/{hist_size}/{hist_name}"))
        hist_url = fixture.url + f"/slow/{hist_size}/{hist_name}?chunk=8192&delayMs=20"
        hist_started = kernel.request(
            "start", {"url": hist_url, "dir": download_dir, "fileName": hist_name, "connections": 1}
        ).get("task") or {}
        hist_id = hist_started.get("id")
        hist_final = wait_status(kernel, hist_id, TERMINAL, timeout=120.0) or {}
        check("v030.history download completed", hist_final.get("status") == "completed", (hist_final.get("status"), hist_final.get("error")))
        check(
            "v030.history file bytes byte-identical",
            sha256_file(os.path.join(download_dir, hist_name)) == hist_expected,
            sha256_file(os.path.join(download_dir, hist_name)),
        )

        def history_read(params: dict | None = None) -> dict:
            request = {"id": hist_id, "offset": 0, "limit": 500, "includeEvents": True, "eventsLimit": 200}
            request.update(params or {})
            return kernel.request("history", request)

        history = poll_until(
            lambda: (lambda page: page if (page.get("totalSamples") or 0) >= 2 else None)(history_read()),
            timeout=15.0,
        )
        check("v030.history RPC returns >= 2 samples", history is not None, "recorded samples < 2")
        history = history or {}
        check(
            "v030.history result fields",
            has_all(
                history,
                [
                    "taskId",
                    "samplesPath",
                    "eventsPath",
                    "samples",
                    "events",
                    "totalSamples",
                    "totalEvents",
                    "truncated",
                    "sampleStride",
                    "offset",
                ],
            ),
            sorted(history.keys()),
        )
        check("v030.history.taskId", history.get("taskId") == hist_id, history.get("taskId"))
        samples = history.get("samples") or []
        sample_keys = ["t", "bytes", "bps", "w1Bps", "w5Bps", "w30Bps", "w300Bps", "workers", "peakWorkers", "stalledMs"]
        check("v030.history samples list has >= 2 entries", isinstance(samples, list) and len(samples) >= 2, len(samples))
        check("v030.history sample fields", bool(samples) and has_all(samples[0], sample_keys), sorted(samples[0].keys()) if samples else [])
        sample_times = [int(sample.get("t") or 0) for sample in samples]
        check("v030.history sample timestamps monotonic", sample_times == sorted(sample_times), sample_times[:8])
        sample_bytes = [int(sample.get("bytes") or 0) for sample in samples]
        check("v030.history sample bytes monotonic", sample_bytes == sorted(sample_bytes), sample_bytes[:8])
        check(
            "v030.history samples track the transfer",
            max(sample_bytes or [0]) <= hist_size and max(sample_bytes or [0]) >= hist_size // 2,
            (min(sample_bytes or [0]), max(sample_bytes or [0]), hist_size),
        )
        check(
            "v030.history totalSamples matches the page",
            history.get("totalSamples") == len(samples),
            (history.get("totalSamples"), len(samples)),
        )

        samples_path = str(history.get("samplesPath") or "")
        events_path = str(history.get("eventsPath") or "")
        expected_history_dir = os.path.normcase(os.path.join(os.path.abspath(data_dir), "history"))
        check(
            "v030.history samplesPath under <dataDir>/history",
            samples_path.endswith(".samples.jsonl")
            and os.path.normcase(os.path.dirname(os.path.abspath(samples_path))) == expected_history_dir,
            samples_path,
        )
        check(
            "v030.history eventsPath under <dataDir>/history",
            events_path.endswith(".events.jsonl")
            and os.path.normcase(os.path.dirname(os.path.abspath(events_path))) == expected_history_dir,
            events_path,
        )
        check("v030.history samples JSONL file exists", os.path.exists(samples_path), samples_path)
        check("v030.history events JSONL file exists", os.path.exists(events_path), events_path)
        sample_lines = read_jsonl(samples_path) if os.path.exists(samples_path) else []
        event_lines = read_jsonl(events_path) if os.path.exists(events_path) else []
        # 0.2.2 writes `{"kind":"meta",...}` header lines into the samples JSONL;
        # the reader excludes them from `totalSamples` and `samples`.
        sample_records = [record for record in sample_lines if record.get("kind") != "meta"]
        check(
            "v030.history samples JSONL line count",
            len(sample_records) == history.get("totalSamples"),
            (len(sample_records), history.get("totalSamples")),
        )
        check(
            "v030.history sample JSONL fields",
            bool(sample_records) and has_all(sample_records[0], sample_keys),
            sorted(sample_records[0].keys()) if sample_records else [],
        )

        events = history.get("events") or []
        event_keys = ["t", "seq", "kind", "message", "chunk", "attempt", "delayMs"]
        check("v030.history events non-empty", isinstance(events, list) and len(events) >= 1, len(events))
        check("v030.history event fields", bool(events) and has_all(events[0], event_keys), sorted(events[0].keys()) if events else [])
        event_kinds = {str(event.get("kind")) for event in events}
        check("v030.history events include plan", "plan" in event_kinds, sorted(event_kinds))
        check("v030.history events include completed", "completed" in event_kinds, sorted(event_kinds))
        check(
            "v030.history events JSONL line count",
            len(event_lines) == history.get("totalEvents"),
            (len(event_lines), history.get("totalEvents")),
        )
        check(
            "v030.history event JSONL fields",
            bool(event_lines) and has_all(event_lines[0], event_keys),
            sorted(event_lines[0].keys()) if event_lines else [],
        )
        check("v030.history truncated false on a full read", history.get("truncated") is False, history.get("truncated"))

        # Raw offset paging is a literal window; the default series is an
        # evenly-downsampled review (first + last always included).
        paged = kernel.request(
            "history",
            {"id": hist_id, "offset": 1, "limit": 1, "raw": True, "includeEvents": False, "eventsLimit": 200},
        )
        paged_samples = paged.get("samples") or []
        check("v030.history raw paging returns at most limit samples", len(paged_samples) <= 1, len(paged_samples))
        check("v030.history raw paging reports the requested offset", paged.get("offset") == 1, paged.get("offset"))
        check(
            "v030.history paging keeps totalSamples",
            paged.get("totalSamples") == history.get("totalSamples"),
            (paged.get("totalSamples"), history.get("totalSamples")),
        )
        if paged_samples and len(samples) >= 2:
            check(
                "v030.history offset selects a later sample",
                paged_samples[0].get("t") == samples[1].get("t"),
                (paged_samples[0].get("t"), samples[1].get("t")),
            )
        check("v030.history includeEvents=false returns empty events", paged.get("events") == [], paged.get("events"))

        total_samples = int(history.get("totalSamples") or 0)
        if total_samples > 2:
            reviewed = kernel.request("history", {"id": hist_id, "offset": 0, "limit": 2, "includeEvents": False})
            reviewed_samples = reviewed.get("samples") or []
            check("v030.history long series downsampled within limit", len(reviewed_samples) <= 3, len(reviewed_samples))
            check(
                "v030.history downsample keeps first and last sample",
                bool(reviewed_samples)
                and reviewed_samples[0].get("t") == samples[0].get("t")
                and reviewed_samples[-1].get("t") == samples[-1].get("t"),
                (len(reviewed_samples), reviewed.get("sampleStride")),
            )
            check(
                "v030.history downsample reports sampleStride > 1",
                (reviewed.get("sampleStride") or 1) > 1,
                reviewed.get("sampleStride"),
            )
        check("v030.history truncated false without the sample cap", history.get("truncated") is False, history.get("truncated"))

        _, unknown_error = kernel.try_request("history", {"id": "t_0000000000000000"})
        check("v030.history unknown task -> not_found", (unknown_error or {}).get("code") == "not_found", unknown_error)

        # ── 5. new TaskView / resumeState fields on a completed task ────────
        view_fields = ["maxConnections", "targetWorkers", "resumedBytes"]
        check("v030.view new fields present on a completed task", has_all(hist_final, view_fields), sorted(hist_final.keys()))
        max_connections = hist_final.get("maxConnections")
        check(
            "v030.view.maxConnections sane",
            isinstance(max_connections, int) and not isinstance(max_connections, bool) and 1 <= max_connections <= 128,
            max_connections,
        )
        check("v030.view.maxConnections default 128", max_connections == 128, max_connections)
        target_workers = hist_final.get("targetWorkers")
        check(
            "v030.view.targetWorkers sane",
            isinstance(target_workers, int)
            and not isinstance(target_workers, bool)
            and 0 <= target_workers <= (max_connections or 128),
            target_workers,
        )
        check("v030.view.resumedBytes 0 for a fresh task", hist_final.get("resumedBytes") == 0, hist_final.get("resumedBytes"))
        hist_detail = kernel.request("get", {"id": hist_id, "events": 0}).get("detail") or {}
        fresh_resume = hist_detail.get("resumeState") or {}
        check(
            "v030.detail.resumeState has decision/reason fields",
            has_all(fresh_resume, ["resumeDecision", "resumeReason"]),
            sorted(fresh_resume.keys()),
        )
        check(
            "v030.detail.resumeDecision sane on a fresh task",
            fresh_resume.get("resumeDecision") in RESUME_DECISIONS,
            fresh_resume.get("resumeDecision"),
        )
        check(
            "v030.detail.resumeReason known or null",
            fresh_resume.get("resumeReason") is None
            or fresh_resume.get("resumeReason") in (ACCEPTED_RESUME_REASONS | REJECTED_RESUME_REASONS),
            fresh_resume.get("resumeReason"),
        )

        # ── 6. recording/files survive a kernel restart on the same data dir ─
        recorded_samples = int(history.get("totalSamples") or 0)
        recorded_events = int(history.get("totalEvents") or 0)
        kernel.close()
        kernel = Kernel(binary, data_dir)
        kernel.request("initialize", init_params)
        history_after = kernel.request("history", {"id": hist_id, "offset": 0, "limit": 500, "includeEvents": True, "eventsLimit": 200})
        check(
            "v030.history survives a kernel restart",
            (history_after.get("totalSamples") or 0) >= recorded_samples,
            (history_after.get("totalSamples"), recorded_samples),
        )
        check(
            "v030.history events survive a kernel restart",
            (history_after.get("totalEvents") or 0) >= recorded_events,
            (history_after.get("totalEvents"), recorded_events),
        )
        check(
            "v030.history paths stable across restart",
            history_after.get("samplesPath") == samples_path and history_after.get("eventsPath") == events_path,
            (history_after.get("samplesPath"), samples_path),
        )
        check("v030.history samples non-empty after restart", bool(history_after.get("samples")), len(history_after.get("samples") or []))
        listed = kernel.request("list", {"limit": 100}).get("tasks") or []
        check(
            "v030.history task record persisted across restart",
            any(task.get("id") == hist_id for task in listed),
            [task.get("id") for task in listed],
        )
    finally:
        kernel.close()


def scenario_v022(fixture: Fixture, binary: str) -> None:
    """0.2.2 verification contract: `.design/0.2.2-spec.md` §4 e2e checks.

    Covers build attribution via history meta records, this-run rate accounting
    on a resumed task, the plan receipt fields, the stable `unsupported_method`
    error code, and readability of legacy (0.2.1) histories without meta lines.
    """
    root = os.path.join(TMP_ROOT, "v022")
    data_dir = os.path.join(root, "kernel-data")
    download_dir = os.path.join(root, "downloads")
    shutil.rmtree(root, ignore_errors=True)
    os.makedirs(data_dir, exist_ok=True)
    os.makedirs(download_dir, exist_ok=True)

    init_params = {
        "defaultDir": download_dir,
        "connections": 4,
        "maxConnections": 1024,
        "chunkSizeBytes": 0,
        "speedLimitBps": 0,
        "maxAttempts": 3,
        "autoResume": False,
        "logLevel": "warn",
        "fsyncOnComplete": False,
    }

    kernel = Kernel(binary, data_dir)
    try:
        kernel.request("initialize", init_params)
        kernel_version = str(field(kernel.ready, "kernel", "version", default=""))
        check("v022.kernel version is 0.3.0-alpha.1 (unified with package)", kernel_version == "0.3.0-alpha.1", kernel_version)

        # ── 1. plan receipt fields + this-run view counters ────────────────
        plan_size = 256 * 1024
        plan_name = "plan-fields.bin"
        plan_started = kernel.request(
            "start",
            {
                "url": fixture.url + f"/ranged/{plan_size}/{plan_name}",
                "dir": download_dir,
                "fileName": plan_name,
                "connections": 4,
                "maxConnections": 128,
            },
        ).get("task") or {}
        plan_id = plan_started.get("id")
        check(
            "v022.start view carries transferredBytes/requestedConnections",
            has_all(plan_started, ["transferredBytes", "requestedConnections"]),
            sorted(plan_started.keys()),
        )
        check("v022.start transferredBytes begins at 0", plan_started.get("transferredBytes") == 0, plan_started.get("transferredBytes"))
        check("v022.start requestedConnections round-trip", plan_started.get("requestedConnections") == 4, plan_started.get("requestedConnections"))
        plan_final = wait_status(kernel, plan_id, TERMINAL, timeout=60.0) or {}
        check("v022.plan task completed", plan_final.get("status") == "completed", (plan_final.get("status"), plan_final.get("error")))
        check(
            "v022.fresh task transferredBytes == downloaded",
            plan_final.get("transferredBytes") == plan_final.get("downloaded"),
            (plan_final.get("transferredBytes"), plan_final.get("downloaded")),
        )
        plan_events = kernel.request("get", {"id": plan_id, "events": 200}).get("events") or []
        plan_messages = [str(event.get("message") or "") for event in plan_events if event.get("kind") == "plan"]
        plan_message = plan_messages[0] if plan_messages else ""
        plan_fields = plan_message_fields(plan_message)
        check("v022.plan message recorded", bool(plan_message), [event.get("kind") for event in plan_events])
        check(
            "v022.plan message has requested=/initial=/ceiling=",
            all(key in plan_fields for key in ("requested", "initial", "ceiling")),
            plan_message,
        )
        check("v022.plan requested == spec connections (4)", plan_fields.get("requested") == "4", plan_fields)
        check(
            "v022.plan initial == view.connections",
            plan_fields.get("initial") == str(plan_final.get("connections")),
            (plan_fields.get("initial"), plan_final.get("connections")),
        )
        plan_chunks = int(plan_fields.get("chunks") or 0)
        expected_ceiling = min(int(plan_final.get("maxConnections") or 128), plan_chunks) if plan_chunks else 0
        check(
            "v022.plan ceiling == min(maxConnections, chunks)",
            plan_fields.get("ceiling") == str(expected_ceiling),
            (plan_fields.get("ceiling"), expected_ceiling, plan_final.get("maxConnections"), plan_chunks),
        )
        check(
            "v022.plan message has chunks/chunk/resumed/resume fields",
            all(key in plan_fields for key in ("chunks", "chunk", "resumed", "resume")),
            plan_message,
        )
        check("v022.plan resumed=0 on a fresh task", plan_fields.get("resumed") == "0", plan_fields)

        # ── 2. unknown RPC method -> unsupported_method ────────────────────
        _, unknown_error = kernel.try_request("nope", {})
        error = unknown_error or {}
        check("v022.unknown method -> unsupported_method", error.get("code") == "unsupported_method", error)
        error_message = str(error.get("message") or "")
        check(
            "v022.unsupported_method message names the method and kernel version",
            "nope" in error_message and (kernel_version in error_message or "upgrade" in error_message.lower()),
            error_message,
        )

        # ── 3. history meta record on a completed task ─────────────────────
        hist_size = 1024 * 1024
        hist_name = "meta-history.bin"
        hist_url = fixture.url + f"/slow/{hist_size}/{hist_name}?chunk=8192&delayMs=20"
        hist_started = kernel.request(
            "start", {"url": hist_url, "dir": download_dir, "fileName": hist_name, "connections": 1}
        ).get("task") or {}
        hist_id = hist_started.get("id")
        hist_final = wait_status(kernel, hist_id, TERMINAL, timeout=120.0) or {}
        check("v022.history task completed", hist_final.get("status") == "completed", (hist_final.get("status"), hist_final.get("error")))

        def history_read(task_id: str, params: dict | None = None) -> dict:
            request = {"id": task_id, "offset": 0, "limit": 500, "includeEvents": True, "eventsLimit": 200}
            request.update(params or {})
            return kernel.request("history", request)

        history = poll_until(
            lambda: (lambda page: page if (page.get("totalSamples") or 0) >= 2 else None)(history_read(hist_id)),
            timeout=15.0,
        )
        check("v022.history RPC returns samples", bool(history), "history samples < 2")
        history = history or {}
        meta = history.get("meta")
        check("v022.history result carries meta/builds", has_all(history, ["meta", "builds"]), sorted(history.keys()))
        check("v022.history result has a meta array", isinstance(meta, list), type(meta).__name__)
        meta = meta or []
        check("v022.history meta record present", len(meta) >= 1, meta)
        record = meta[-1] if meta else {}
        check("v022.meta.kind == meta", record.get("kind") == "meta", record.get("kind"))
        check("v022.meta.kernelVersion matches ready", record.get("kernelVersion") == kernel_version, record.get("kernelVersion"))
        check("v022.meta.pid is a positive int", isinstance(record.get("pid"), int) and record.get("pid") > 0, record.get("pid"))
        check("v022.meta.taskId", record.get("taskId") == hist_id, record.get("taskId"))
        check("v022.meta.phase plan", record.get("phase") == "plan", record.get("phase"))
        check("v022.meta.run >= 1", isinstance(record.get("run"), int) and record.get("run") >= 1, record.get("run"))
        check("v022.meta.fileName", record.get("fileName") == hist_name, record.get("fileName"))
        check("v022.meta.totalBytes == size", record.get("totalBytes") == hist_size, record.get("totalBytes"))
        check("v022.meta.chunks >= 1", isinstance(record.get("chunks"), int) and record.get("chunks") >= 1, record.get("chunks"))
        check("v022.meta.chunkSize >= 1", isinstance(record.get("chunkSize"), int) and record.get("chunkSize") >= 1, record.get("chunkSize"))
        check("v022.meta.requestedConnections == 1", record.get("requestedConnections") == 1, record.get("requestedConnections"))
        check(
            "v022.meta.initialWorkers >= 1",
            isinstance(record.get("initialWorkers"), int) and record.get("initialWorkers") >= 1,
            record.get("initialWorkers"),
        )
        meta_chunks = int(record.get("chunks") or 0)
        check(
            "v022.meta.maxConnections is the effective ceiling min(128, chunks)",
            meta_chunks > 0 and record.get("maxConnections") == min(128, meta_chunks),
            (record.get("maxConnections"), meta_chunks),
        )
        check("v022.meta.resumedBytes 0 on a fresh task", record.get("resumedBytes") == 0, record.get("resumedBytes"))
        check(
            "v022.meta.resumeDecision not-attempted on a fresh task",
            record.get("resumeDecision") == "not-attempted",
            record.get("resumeDecision"),
        )
        check("v022.meta.resumeReason null on a fresh task", record.get("resumeReason") is None, record.get("resumeReason"))
        builds = sorted(
            {
                f"{entry.get('kernelVersion')}@{entry.get('pid')}"
                for entry in meta
                if entry.get("kernelVersion") and isinstance(entry.get("pid"), int)
            }
        )
        check("v022.history meta derives build tags (version@pid)", bool(builds) and all("@" in build for build in builds), builds)
        history_builds = history.get("builds")
        check(
            "v022.history builds array matches meta build tags",
            isinstance(history_builds, list) and set(str(build) for build in history_builds) == set(builds),
            (history_builds, builds),
        )

        samples_path = str(history.get("samplesPath") or "")
        check("v022.history samplesPath exists on disk", bool(samples_path) and os.path.exists(samples_path), samples_path)
        all_records = read_jsonl(samples_path) if samples_path else []
        meta_lines = [record for record in all_records if record.get("kind") == "meta"]
        sample_lines = [record for record in all_records if record.get("kind") != "meta"]
        check("v022.history JSONL contains meta header lines", len(meta_lines) >= 1, len(meta_lines))
        check(
            "v022.history totalSamples excludes meta lines",
            len(sample_lines) == history.get("totalSamples"),
            (len(sample_lines), history.get("totalSamples")),
        )

        # ── 4. resumed task: this-run rate accounting + a second meta run ──
        rate_size = 4 * 1024 * 1024
        rate_name = "resume-rate.bin"
        rate_url = fixture.url + f"/slow/{rate_size}/{rate_name}?chunk=16384&delayMs=15"
        rate_started = kernel.request(
            "start", {"url": rate_url, "dir": download_dir, "fileName": rate_name, "connections": 4}
        ).get("task") or {}
        rate_id = rate_started.get("id")
        threshold = rate_size // 4
        progressed = poll_until(
            lambda: (lambda view: view if (view.get("downloaded") or 0) >= threshold else None)(task_view(kernel, rate_id)),
            timeout=30.0,
        )
        check("v022.resume first run reached 25%", bool(progressed), (task_view(kernel, rate_id).get("downloaded"), rate_size))
        kernel.request("control", {"id": rate_id, "action": "pause"})
        paused = wait_status(kernel, rate_id, {"paused"}, timeout=20.0) or {}
        check("v022.resume paused mid-transfer", paused.get("status") == "paused", paused.get("status"))
        kernel.request("control", {"id": rate_id, "action": "resume"})
        resumed = wait_status(kernel, rate_id, TERMINAL, timeout=120.0) or {}
        check("v022.resumed transfer completed", resumed.get("status") == "completed", (resumed.get("status"), resumed.get("error")))
        downloaded = int(resumed.get("downloaded") or 0)
        transferred = resumed.get("transferredBytes")
        resumed_bytes = int(resumed.get("resumedBytes") or 0)
        check("v022.resumed view has transferredBytes", isinstance(transferred, int), transferred)
        check(
            "v022.resumed transferredBytes < downloaded",
            isinstance(transferred, int) and 0 <= transferred < downloaded,
            (transferred, downloaded),
        )
        check(
            "v022.resumed transferredBytes + resumedBytes == downloaded",
            isinstance(transferred, int) and transferred + resumed_bytes == downloaded,
            (transferred, resumed_bytes, downloaded),
        )
        peak = int(resumed.get("peakBps") or 0)
        avg = int(resumed.get("avgBps") or 0)
        check("v022.resumed peakBps is a plausible this-run rate (no 8 GiB/s spike)", 0 < peak < 1024 * 1024 * 1024, peak)
        check("v022.resumed avgBps is a plausible this-run rate", 0 <= avg < 1024 * 1024 * 1024, avg)
        resumed_get = kernel.request("get", {"id": rate_id, "events": 200})
        resumed_plans = [str(event.get("message") or "") for event in (resumed_get.get("events") or []) if event.get("kind") == "plan"]
        resumed_plan = resumed_plans[-1] if resumed_plans else ""
        resumed_fields = plan_message_fields(resumed_plan)
        check(
            "v022.resumed plan message has requested=/ceiling=",
            "requested" in resumed_fields and "ceiling" in resumed_fields,
            resumed_plan,
        )
        try:
            resumed_count = int(str(resumed_fields.get("resumed", "0")).replace(",", ""))
        except ValueError:
            resumed_count = 0
        check("v022.resumed plan reports resumed= > 0", resumed_count > 0, resumed_fields)
        resumed_history = history_read(rate_id)
        resumed_meta = resumed_history.get("meta") or []
        check("v022.resumed history has meta records", len(resumed_meta) >= 1, len(resumed_meta))
        runs = [entry.get("run") for entry in resumed_meta if isinstance(entry.get("run"), int)]
        check(
            "v022.resumed history has a second run meta record",
            len(runs) >= 2 and runs == sorted(runs) and runs[-1] >= 2,
            runs,
        )
        sample_bps = [int(sample.get("bps") or 0) for sample in (resumed_history.get("samples") or [])]
        check(
            "v022.resumed sample series has no inflated rate",
            bool(sample_bps) and max(sample_bps) < 1024 * 1024 * 1024,
            max(sample_bps or [0]),
        )

        # ── 5. history meta survives a kernel restart ──────────────────────
        meta_before = len(history.get("meta") or [])
        pid_before = record.get("pid")
        kernel.close()
        kernel = Kernel(binary, data_dir)
        kernel.request("initialize", init_params)
        history_after = kernel.request(
            "history", {"id": hist_id, "offset": 0, "limit": 500, "includeEvents": True, "eventsLimit": 200}
        )
        restarted_meta = history_after.get("meta") or []
        check(
            "v022.history meta survives kernel restart",
            len(restarted_meta) >= meta_before,
            (len(restarted_meta), meta_before),
        )
        check(
            "v022.history meta identical after restart (build attribution kept)",
            bool(restarted_meta)
            and restarted_meta[-1].get("kernelVersion") == kernel_version
            and restarted_meta[-1].get("pid") == pid_before,
            (restarted_meta[-1] if restarted_meta else None, {"kernelVersion": kernel_version, "pid": pid_before}),
        )

        # ── 6. legacy (0.2.1) history JSONL without meta still reads ───────
        kernel.close()
        legacy_records = [entry for entry in read_jsonl(samples_path) if entry.get("kind") != "meta"]
        with open(samples_path, "w", encoding="utf-8") as handle:
            for entry in legacy_records:
                handle.write(json.dumps(entry) + "\n")
        kernel = Kernel(binary, data_dir)
        kernel.request("initialize", init_params)
        legacy_history = kernel.request(
            "history", {"id": hist_id, "offset": 0, "limit": 500, "includeEvents": True, "eventsLimit": 200}
        )
        check(
            "v022.legacy history without meta reads its samples",
            (legacy_history.get("totalSamples") or 0) == len(legacy_records),
            (legacy_history.get("totalSamples"), len(legacy_records)),
        )
        check("v022.legacy history exposes an empty meta list", legacy_history.get("meta") == [], legacy_history.get("meta"))
        check("v022.legacy history exposes an empty builds list", legacy_history.get("builds") == [], legacy_history.get("builds"))
        check("v022.legacy history samples non-empty", bool(legacy_history.get("samples")), len(legacy_history.get("samples") or []))
    finally:
        kernel.close()


def run_group(group: str, fn, fixture: Fixture, binary: str) -> None:
    print(f"\n── group {group} ──")
    try:
        fn(fixture, binary)
    except Exception:
        traceback.print_exc()
        CHECKS.append({"name": f"harness.{group}.exception", "ok": False, "detail": traceback.format_exc()[-1600:]})


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--kernel", default=None)
    parser.add_argument("--json", default=None)
    parser.add_argument("--only", default=None, help="comma-separated groups: core,v030,v022")
    args = parser.parse_args()
    binary = args.kernel or platform_kernel()
    os.makedirs(TMP_ROOT, exist_ok=True)
    cleanup_stale_run_roots(os.path.dirname(TMP_ROOT))
    if not os.path.exists(binary):
        print(f"kernel binary not found: {binary}", file=sys.stderr)
        return 2
    groups = [("core", scenario), ("v030", scenario_v030), ("v022", scenario_v022)]
    if args.only:
        wanted = {part.strip() for part in args.only.split(",") if part.strip()}
        groups = [(name, fn) for name, fn in groups if name in wanted]
        if not groups:
            print(f"no groups matched --only {args.only!r}", file=sys.stderr)
            return 2
    fixture = None
    started = time.time()
    try:
        fixture = Fixture()
        for name, fn in groups:
            run_group(name, fn, fixture, binary)
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
