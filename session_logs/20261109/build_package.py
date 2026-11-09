"""Assemble the dsh-rdm session package from the kernel's own records.

Inputs (read-only):
  .rdm-data/tasks/t_*.json            final task records
  .rdm-data/history/*.samples.jsonl   kernel sample stream (10 Hz)
  .rdm-data/history/*.events.jsonl    kernel event stream

Outputs (D:\\llm\\rdm-record):
  tasks.json, telemetry-kernel.csv, events.csv, kernel-history.json
  telemetry-kernel/<id>.{samples,events}.jsonl   verbatim copies
"""
import json
import pathlib
import shutil
import statistics
from datetime import datetime, timezone, timedelta

TZ = timezone(timedelta(hours=8))
RDM = pathlib.Path(r"C:\Users\nirvana\Documents\deepseek-harness\dsh-rdm\.rdm-data")
OUT = pathlib.Path(r"D:\llm\rdm-record")
IDS = ["t_248a5911009cc18d", "t_7359f357ea3922cb", "t_6a665d4e17fa3100", "t_ebda50bb99a77a14"]
MiB = 1024.0 * 1024.0


def iso(ms):
    return datetime.fromtimestamp(ms / 1000, TZ).isoformat(timespec="milliseconds")


def utc(ms):
    return datetime.fromtimestamp(ms / 1000, timezone.utc).strftime("%H:%M:%S.%f")[:-3]


def quant(vals, p):
    if not vals:
        return None
    v = sorted(vals)
    k = (len(v) - 1) * p
    lo, hi = int(k), min(int(k) + 1, len(v) - 1)
    return v[lo] + (v[hi] - v[lo]) * (k - lo)


def main():
    hist_src = RDM / "history"
    hist_out = OUT / "telemetry-kernel"
    hist_out.mkdir(exist_ok=True)
    (OUT / "tasks-final").mkdir(exist_ok=True)

    events_rows = ["task,seq,utc,local,kind,chunk,attempt,delay_ms,message"]
    sample_rows = ["task,utc,local,bytes,bps,w1Bps,w5Bps,w30Bps,w300Bps,workers,peakWorkers,stalledMs"]
    stats = {}

    for tid in IDS:
        # raw copies
        for kind in ("samples", "events"):
            src = hist_src / ("%s.%s.jsonl" % (tid, kind))
            if src.exists():
                shutil.copyfile(src, hist_out / src.name)
        # task record
        tp = RDM / "tasks" / ("%s.json" % tid)
        if tp.exists():
            shutil.copyfile(tp, OUT / "tasks-final" / tp.name)

        sp = hist_src / ("%s.samples.jsonl" % tid)
        ep = hist_src / ("%s.events.jsonl" % tid)
        samples = []
        if sp.exists():
            for line in sp.read_text(encoding="utf-8").splitlines():
                line = line.strip()
                if not line:
                    continue
                r = json.loads(line)
                if r.get("truncated"):
                    continue
                samples.append(r)
                sample_rows.append("%s,%s,%s,%d,%d,%d,%d,%d,%d,%s,%s,%s" % (
                    tid, utc(r["t"]), iso(r["t"]), r["bytes"], r["bps"], r["w1Bps"], r["w5Bps"],
                    r["w30Bps"], r["w300Bps"], r.get("workers", ""), r.get("peakWorkers", ""),
                    r.get("stalledMs", "")))
        evs = []
        if ep.exists():
            for line in ep.read_text(encoding="utf-8").splitlines():
                line = line.strip()
                if not line:
                    continue
                r = json.loads(line)
                evs.append(r)
                msg = (r.get("message") or "").replace(",", ";")
                events_rows.append("%s,%s,%s,%s,%s,%s,%s,%s,%s" % (
                    tid, r.get("seq", ""), utc(r["t"]), iso(r["t"]), r.get("kind", ""),
                    r.get("chunk") if r.get("chunk") is not None else "",
                    r.get("attempt") if r.get("attempt") is not None else "",
                    r.get("delayMs") if r.get("delayMs") is not None else "", msg))
        bps = [r["bps"] for r in samples if r.get("bps") is not None]
        workers = [r.get("workers") for r in samples if r.get("workers") is not None]
        stats[tid] = {
            "samples": len(samples),
            "events": len(evs),
            "span_s": round((samples[-1]["t"] - samples[0]["t"]) / 1000, 1) if len(samples) > 1 else None,
            "first_sample": iso(samples[0]["t"]) if samples else None,
            "last_sample": iso(samples[-1]["t"]) if samples else None,
            "bps_mean_MiB_s": round((sum(bps) / len(bps)) / MiB, 2) if bps else None,
            "bps_p50_MiB_s": round(quant(bps, 0.5) / MiB, 2) if bps else None,
            "bps_p95_MiB_s": round(quant(bps, 0.95) / MiB, 2) if bps else None,
            "bps_max_MiB_s": round(max(bps) / MiB, 2) if bps else None,
            "workers_min": min(workers) if workers else None,
            "workers_max": max(workers) if workers else None,
            "stalled_max_ms": max([r.get("stalledMs") or 0 for r in samples], default=0),
        }

    (OUT / "events.csv").write_text("\n".join(events_rows) + "\n", encoding="utf-8")
    (OUT / "telemetry-kernel.csv").write_text("\n".join(sample_rows) + "\n", encoding="utf-8")
    (OUT / "kernel-history.json").write_text(json.dumps(stats, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(stats, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
