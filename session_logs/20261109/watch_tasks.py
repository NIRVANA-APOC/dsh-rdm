"""Sample the dsh-rdm kernel's task records into a JSONL time series.

The kernel keeps only the latest snapshot per task in .rdm-data/tasks/<id>.json and this
build exposes no history method, so a download's time series has to be sampled from the
outside.  Every 2 s this reads the task files of a fixed id set and appends a row when any
watched value changed.

Usage:  python watch_tasks.py [--seconds N] [--interval S]
Stops early when <out>/STOP exists.
"""
import argparse
import hashlib
import json
import os
import pathlib
import shutil
import time
from datetime import datetime, timezone, timedelta

TASKS_DIR = pathlib.Path(os.environ.get(
    "RDM_TASKS_DIR",
    r"C:\Users\nirvana\Documents\deepseek-harness\dsh-rdm\.rdm-data\tasks"))
OUT = pathlib.Path(r"D:\llm\rdm-record")
IDS = [
    "t_248a5911009cc18d",   # mmproj 866 MiB   (completed, verified)
    "t_7359f357ea3922cb",   # shard 2 26.8 GiB (completed)
    "t_6a665d4e17fa3100",   # shard 1 attempt 1: expected sha = pinned e11083ba (cancelled, .part kept)
    "t_ebda50bb99a77a14",   # shard 1 attempt 2: expected sha = HF main bfa3644d (resumed from .part)
]
KEYS = ["status", "downloaded", "total", "percent", "speedBps", "speed1sBps", "speed5sBps",
        "speed30sBps", "avgBps", "peakBps", "etaSecs", "stalledMs", "activeWorkers",
        "peakWorkers", "connections", "chunkSize", "resumedChunks", "retries", "sha256",
        "verified", "error"]


def now_iso():
    return datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--seconds", type=int, default=3 * 3600)
    ap.add_argument("--interval", type=float, default=2.0)
    a = ap.parse_args()
    (OUT / "snapshots").mkdir(parents=True, exist_ok=True)
    samples = (OUT / "samples.jsonl").open("a", encoding="utf-8")
    last = {}
    stopped = OUT / "STOP"
    end = time.time() + a.seconds
    while time.time() < end and not stopped.exists():
        for tid in IDS:
            p = TASKS_DIR / (tid + ".json")
            try:
                raw = p.read_bytes()
                j = json.loads(raw)
            except (OSError, ValueError):
                continue
            row = {"ts": now_iso(), "id": tid}
            row.update({k: j.get(k) for k in KEYS if k in j})
            sig = hashlib.sha1(json.dumps(row, sort_keys=True, default=str).encode()).hexdigest()
            if last.get(tid) == sig:
                continue
            last[tid] = sig
            samples.write(json.dumps(row, ensure_ascii=False) + "\n")
            samples.flush()
            if row.get("status") in ("completed", "failed", "cancelled"):
                dst = OUT / "snapshots" / ("%s__%s.json" % (tid, row["status"]))
                if not dst.exists():
                    shutil.copyfile(p, dst)
        time.sleep(a.interval)
    samples.close()
    # final full copies
    final = OUT / "tasks-final"
    final.mkdir(parents=True, exist_ok=True)
    for tid in IDS:
        p = TASKS_DIR / (tid + ".json")
        if p.exists():
            shutil.copyfile(p, final / p.name)
    print("watcher done", now_iso())


if __name__ == "__main__":
    main()
