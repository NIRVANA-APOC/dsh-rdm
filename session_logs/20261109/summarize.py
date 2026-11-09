"""Turn the sampled telemetry (samples.jsonl) and the final kernel task records
(tasks-final/*.json) into one machine-readable summary for dsh-rdm tuning."""
import json
import pathlib
import statistics
from datetime import datetime

OUT = pathlib.Path(r"D:\llm\rdm-record")
MiB = 1024.0 * 1024.0


def pct(vals, p):
    if not vals:
        return None
    vals = sorted(vals)
    k = (len(vals) - 1) * p
    lo, hi = int(k), min(int(k) + 1, len(vals) - 1)
    return vals[lo] + (vals[hi] - vals[lo]) * (k - lo)


def main():
    rows = []
    for p in sorted((OUT / "samples.jsonl").read_text(encoding="utf-8").splitlines()):
        p = p.strip()
        if p:
            rows.append(json.loads(p))
    by_id = {}
    for r in rows:
        by_id.setdefault(r["id"], []).append(r)

    out = {"generated": datetime.now().astimezone().isoformat(timespec="seconds"),
           "kernel": {"id": "rdm-kernel 1.1.0", "data_dir": r"C:\Users\nirvana\Documents\deepseek-harness\dsh-rdm\.rdm-data"},
           "tasks": []}
    for f in sorted((OUT / "tasks-final").glob("t_*.json")):
        j = json.loads(f.read_text(encoding="utf-8"))
        s = by_id.get(j["id"], [])
        speeds = [r.get("speedBps") or 0 for r in s]
        workers = []
        prev = None
        for r in s:
            w = r.get("activeWorkers")
            if w != prev:
                workers.append({"ts": r["ts"], "workers": w})
                prev = w
        t = {
            "id": j["id"],
            "file": j.get("fileName"),
            "status": j.get("status"),
            "total_bytes": j.get("total"),
            "downloaded_bytes": j.get("downloaded"),
            "elapsed_ms": j.get("elapsedMs"),
            "avg_MiB_s": round((j.get("avgBps") or 0) / MiB, 2),
            "peak_MiB_s": round((j.get("peakBps") or 0) / MiB, 2),
            "chunk_bytes": j.get("chunkSize"),
            "connections": j.get("connections"),
            "peak_workers": j.get("peakWorkers"),
            "resumed_chunks": j.get("resumedChunks"),
            "retries": j.get("retries"),
            "expected_sha256": j.get("expectedSha256"),
            "sha256": j.get("sha256"),
            "verified": j.get("verified"),
            "startedAt": j.get("startedAt"),
            "finishedAt": j.get("finishedAt"),
            "server": j.get("server"),
            "final_host": (j.get("finalUrl") or "").split("/")[2] if j.get("finalUrl") else None,
            "samples": len(s),
            "sample_span_s": None,
            "speed_p50_MiB_s": round((pct(speeds, 0.5) or 0) / MiB, 2),
            "speed_p95_MiB_s": round((pct(speeds, 0.95) or 0) / MiB, 2),
            "max_stalled_ms": max([r.get("stalledMs") or 0 for r in s], default=0),
            "worker_changes": workers,
        }
        if len(s) >= 2:
            a = datetime.fromisoformat(s[0]["ts"])
            b = datetime.fromisoformat(s[-1]["ts"])
            t["sample_span_s"] = round((b - a).total_seconds(), 1)
        out["tasks"].append(t)

    (OUT / "record.json").write_text(json.dumps(out, ensure_ascii=False, indent=2), encoding="utf-8")
    print("wrote", OUT / "record.json", "tasks:", len(out["tasks"]))


if __name__ == "__main__":
    main()
