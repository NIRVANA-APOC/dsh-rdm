import argparse
import hashlib
import json
import os
import random
import shutil
import statistics
import subprocess
import sys
import threading
import time
import urllib.parse
import urllib.request

import psutil

ROOT = r"C:\Users\nirvana\Documents\deepseek-harness\dsh-rdm"
BENCH = os.path.join(ROOT, ".tmp", "bench")
KERNEL = os.path.join(ROOT, "bin", "win32-x64", "rdm-kernel.exe")
ARIA = os.path.join(BENCH, "aria2", "aria2-1.37.0-win-64bit-build1", "aria2c.exe")
GOPEED = os.path.join(BENCH, "tools", "gopeed-web", "gopeed-web-v1.9.3-windows-amd64", "gopeed.exe")
sys.path.insert(0, os.path.join(ROOT, "tests"))
from verify_e2e import Kernel, wait_task  # noqa: E402

UA = "curl/8.9.1"
GOPEED_PORT = 18123
GOPEED_TOKEN = "bench-token"

BASE = "https://mirrors.bfsu.edu.cn/alpine/v3.20/releases/x86_64"
TASKS = {
    "small": {
        "label": "Alpine minirootfs (3.3 MiB)",
        "url": f"{BASE}/alpine-minirootfs-3.20.3-x86_64.tar.gz",
        "bytes": 3490290,
        "sha256": "d4e6fd67dcf75e40c451560ac7265166c2b72a0f38ddc9aae756a7de3d1efa0c",
        "reps": 5,
    },
    "medium": {
        "label": "Alpine virt ISO (61 MiB)",
        "url": f"{BASE}/alpine-virt-3.20.3-x86_64.iso",
        "bytes": 63963136,
        "sha256": "81df854fbd7327d293c726b1eeeb82061d3bc8f5a86a6f77eea720f6be372261",
        "reps": 5,
    },
    "large": {
        "label": "Alpine extended ISO (986 MiB)",
        "url": f"{BASE}/alpine-extended-3.20.3-x86_64.iso",
        "bytes": 1033895936,
        "sha256": "942b4591f86c9989b0cf8874d12d8ee733dc5508004890941440c51ceefea93a",
        "reps": 2,
    },
    "redirect": {
        "label": "GitHub release asset (38.5 MiB, 302 to Azure)",
        "url": "https://github.com/GopeedLab/gopeed/releases/download/v1.9.3/gopeed-web-v1.9.3-windows-amd64.zip",
        "bytes": 40411930,
        "sha256": "ee3d41fa19c366b820a2483619328156579108ac03c53ea35cdb33327320f756",
        "reps": 4,
    },
}

TOOLS = ["rdm", "aria2", "gopeed"]


class Sampler:
    """Sample one process's CPU and peak RSS while a run is active."""

    def __init__(self, pid):
        self.proc = psutil.Process(pid)
        self.stop = threading.Event()
        self.thread = threading.Thread(target=self._run, daemon=True)
        self.cpu = 0.0
        self.peak_rss = 0

    def _run(self):
        while not self.stop.is_set():
            try:
                times = self.proc.cpu_times()
                self.cpu = times.user + times.system
                self.peak_rss = max(self.peak_rss, self.proc.memory_info().rss)
            except (psutil.NoSuchProcess, psutil.AccessDenied):
                break
            self.stop.wait(0.1)

    def __enter__(self):
        self.thread.start()
        return self

    def __exit__(self, exc_type, exc, tb):
        self.stop.set()
        self.thread.join(timeout=2)
        try:
            times = self.proc.cpu_times()
            self.cpu = times.user + times.system
            self.peak_rss = max(self.peak_rss, self.proc.memory_info().rss)
        except (psutil.NoSuchProcess, psutil.AccessDenied):
            pass


def sha256_file(path):
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for block in iter(lambda: handle.read(8 * 1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def remove_quietly(path):
    try:
        os.remove(path)
    except FileNotFoundError:
        pass


class Gopeed:
    def __init__(self, work):
        self.work = work
        self.storage = os.path.join(work, "gopeed-storage")
        os.makedirs(self.storage, exist_ok=True)
        self.proc = subprocess.Popen(
            [GOPEED, "-A", "127.0.0.1", "-P", str(GOPEED_PORT), "-T", GOPEED_TOKEN, "-d", self.storage],
            cwd=work,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        self.base = f"http://127.0.0.1:{GOPEED_PORT}"

    def _request(self, method, path, body=None):
        data = None if body is None else json.dumps(body).encode("utf-8")
        request = urllib.request.Request(
            self.base + path,
            data=data,
            method=method,
            headers={"X-Api-Token": GOPEED_TOKEN, "Content-Type": "application/json"},
        )
        with urllib.request.urlopen(request, timeout=30) as response:
            return json.loads(response.read().decode("utf-8"))

    def wait_ready(self, timeout=20):
        deadline = time.time() + timeout
        while time.time() < deadline:
            try:
                result = self._request("GET", "/api/v1/info")
                if result.get("code") == 0:
                    return result["data"]
            except Exception:
                pass
            time.sleep(0.1)
        raise RuntimeError("gopeed did not become ready")

    def run(self, task, name, download_dir, connections, file_path):
        body = {
            "req": {"url": task["url"], "extra": {"method": "GET", "header": {"User-Agent": UA}}},
            "opts": {"path": download_dir, "name": name, "extra": {"connections": connections}},
        }
        started = time.perf_counter()
        created = self._request("POST", "/api/v1/tasks", body)
        if created.get("code") != 0:
            raise RuntimeError(f"gopeed create failed: {created}")
        task_id = created["data"]
        deadline = time.time() + 300
        last = None
        while time.time() < deadline:
            result = self._request("GET", f"/api/v1/tasks/{task_id}")
            last = result.get("data") or {}
            status = last.get("status")
            if status == "done":
                break
            if status == "error":
                raise RuntimeError(f"gopeed task error: {last}")
            time.sleep(0.05)
        else:
            raise RuntimeError(f"gopeed task timeout: {last}")
        elapsed = time.perf_counter() - started
        if not os.path.exists(file_path):
            raise RuntimeError(f"gopeed file missing: {file_path}")
        try:
            self._request("DELETE", f"/api/v1/tasks/{task_id}")
        except Exception:
            pass
        return elapsed, last

    def close(self):
        self.proc.terminate()
        try:
            self.proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            self.proc.kill()


def run_rdm(task, work, run_index, name, download_dir, connections, max_connections):
    data_dir = os.path.join(work, f"data-rdm-{run_index}-{max_connections}")
    os.makedirs(data_dir, exist_ok=True)
    kernel = Kernel(KERNEL, data_dir)
    try:
        kernel.request(
            "initialize",
            {
                "defaultDir": download_dir,
                "connections": connections,
                "maxConnections": max_connections,
                "autoResume": False,
                "logLevel": "warn",
            },
        )
        started = time.perf_counter()
        response = kernel.request(
            "start",
            {
                "url": task["url"],
                "dir": download_dir,
                "fileName": name,
                "connections": connections,
                "maxConnections": max_connections,
                "headers": {"User-Agent": UA},
            },
        )
        started_task = response.get("task") or {}
        task_id = started_task.get("id")
        with Sampler(kernel.proc.pid) as sampler:
            final = wait_task(kernel, task_id, timeout=300)
            elapsed = time.perf_counter() - started
        return elapsed, final, sampler.cpu, sampler.peak_rss
    finally:
        kernel.close()
        shutil.rmtree(data_dir, ignore_errors=True)


def run_aria2(task, work, run_index, name, download_dir):
    out = os.path.join(download_dir, name)
    command = [
        ARIA,
        "--no-conf",
        "-x16",
        "-s16",
        "-k1M",
        "--file-allocation=none",
        "--allow-overwrite=true",
        "--auto-file-renaming=false",
        "--summary-interval=0",
        "--console-log-level=warn",
        "--download-result=hide",
        f"--user-agent={UA}",
        f"--dir={download_dir}",
        f"--out={name}",
        task["url"],
    ]
    started = time.perf_counter()
    proc = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    with Sampler(proc.pid) as sampler:
        stdout, stderr = proc.communicate(timeout=300)
        elapsed = time.perf_counter() - started
    if proc.returncode != 0:
        raise RuntimeError(f"aria2 exit {proc.returncode}: {stderr[-800:]}")
    if not os.path.exists(out):
        raise RuntimeError(f"aria2 file missing: {out}")
    return elapsed, {"path": out, "status": "completed"}, sampler.cpu, sampler.peak_rss


def summarize(rows):
    groups = {}
    for row in rows:
        groups.setdefault((row["task"], row["tool"]), []).append(row)
    summary = []
    for (task, tool), values in sorted(groups.items()):
        ok = [value for value in values if value["verified"]]
        summary.append(
            {
                "task": task,
                "tool": tool,
                "runs": len(values),
                "verified": len(ok),
                "wall_s_median": round(statistics.median(v["wall_s"] for v in values), 3),
                "wall_s_min": round(min(v["wall_s"] for v in values), 3),
                "speed_mib_s_median": round(statistics.median(v["speed_mib_s"] for v in values), 2),
                "cpu_s_median": round(statistics.median(v["cpu_s"] for v in values), 3),
                "cpu_pct_median": round(statistics.median(v["cpu_pct"] for v in values), 1),
                "rss_mb_peak": round(max(v["rss_mb"] for v in values), 1),
                "peak_workers": max((v.get("peak_workers") or 0) for v in values),
            }
        )
    return summary


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--tasks", default="small,medium,large,redirect")
    parser.add_argument("--reps", type=int, default=0)
    parser.add_argument("--rdm-adaptive", action="store_true")
    parser.add_argument("--out", default="")
    args = parser.parse_args()

    requested = [name.strip() for name in args.tasks.split(",") if name.strip()]
    for name in requested:
        if name not in TASKS:
            raise SystemExit(f"unknown task {name}")

    stamp = time.strftime("%Y%m%d-%H%M%S")
    work = os.path.join(BENCH, "runs", stamp)
    download_dir = os.path.join(work, "downloads")
    os.makedirs(download_dir, exist_ok=True)
    gopeed = Gopeed(work)
    gopeed_info = gopeed.wait_ready()
    print(f"gopeed {gopeed_info.get('version')} ready; work={work}", flush=True)

    rows = []
    random.seed(42)
    try:
        for task_name in requested:
            task = TASKS[task_name]
            reps = args.reps or task["reps"]
            tools = list(TOOLS)
            if args.rdm_adaptive and task_name == "large":
                tools.append("rdm-adaptive")
            order = list(tools)
            random.shuffle(order)
            for run_index in range(reps):
                run_order = list(order)
                random.shuffle(run_order)
                for tool in run_order:
                    name = f"{tool}-{task_name}-{run_index}-{int(time.time() * 1000)}.bin"
                    path = os.path.join(download_dir, name)
                    if tool in ("rdm", "rdm-adaptive"):
                        connections = 8 if tool == "rdm-adaptive" else 16
                        max_connections = 128 if tool == "rdm-adaptive" else 16
                        elapsed, final, cpu, rss = run_rdm(
                            task, work, f"{task_name}-{run_index}-{tool}", name, download_dir, connections, max_connections
                        )
                        peak_workers = final.get("peakWorkers")
                        status = final.get("status")
                    elif tool == "aria2":
                        elapsed, final, cpu, rss = run_aria2(task, work, f"{task_name}-{run_index}", name, download_dir)
                        peak_workers = 16
                        status = final.get("status")
                    else:
                        proc = psutil.Process(gopeed.proc.pid)
                        before = proc.cpu_times()
                        with Sampler(gopeed.proc.pid) as sampler:
                            elapsed, final = gopeed.run(task, name, download_dir, 16, path)
                        after = proc.cpu_times()
                        cpu = (after.user + after.system) - (before.user + before.system)
                        rss = sampler.peak_rss
                        peak_workers = 16
                        status = final.get("status")
                    actual = os.path.getsize(path) if os.path.exists(path) else 0
                    digest = sha256_file(path) if actual else ""
                    verified = actual == task["bytes"] and digest == task["sha256"]
                    row = {
                        "task": task_name,
                        "label": task["label"],
                        "tool": tool,
                        "run": run_index,
                        "wall_s": elapsed,
                        "bytes": actual,
                        "speed_mib_s": actual / 1048576 / elapsed if elapsed else 0,
                        "cpu_s": cpu,
                        "cpu_pct": cpu / elapsed * 100 if elapsed else 0,
                        "rss_mb": rss / 1048576,
                        "peak_workers": peak_workers,
                        "verified": verified,
                        "status": status,
                    }
                    rows.append(row)
                    print(
                        f"{task_name:8} {tool:6} r{run_index} {elapsed:7.3f}s "
                        f"{row['speed_mib_s']:7.2f} MiB/s cpu={cpu:6.2f}s "
                        f"rss={row['rss_mb']:6.1f}MB verified={verified}",
                        flush=True,
                    )
                    remove_quietly(path)
    finally:
        gopeed.close()

    summary = summarize(rows)
    result = {
        "startedAt": stamp,
        "ua": UA,
        "gopeedPort": GOPEED_PORT,
        "tasks": {name: {k: v for k, v in TASKS[name].items()} for name in requested},
        "rows": rows,
        "summary": summary,
    }
    out = args.out or os.path.join(work, "results.json")
    os.makedirs(os.path.dirname(out), exist_ok=True)
    with open(out, "w", encoding="utf-8") as handle:
        json.dump(result, handle, ensure_ascii=False, indent=2)
    print(f"\nwrote {out}")
    print(f"{'task':8} {'tool':6} {'n':>2} {'wall(s)':>9} {'MiB/s':>8} {'cpu(s)':>7} {'cpu%':>6} {'rssMB':>7} workers")
    for item in summary:
        print(
            f"{item['task']:8} {item['tool']:6} {item['runs']:2d} {item['wall_s_median']:9.3f} "
            f"{item['speed_mib_s_median']:8.2f} {item['cpu_s_median']:7.3f} "
            f"{item['cpu_pct_median']:6.1f} {item['rss_mb_peak']:7.1f} {item['peak_workers']}"
        )


if __name__ == "__main__":
    main()
