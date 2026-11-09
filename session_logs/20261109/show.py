import json

d = json.load(open(r"D:\llm\rdm-record\record.json", encoding="utf-8"))
for t in d["tasks"]:
    print("%s %-9s %7.2fGiB avg=%6.1f p50=%6.1f p95=%7.1f peakW=%3d samples=%4d span=%6.1fs stall=%dms verify=%s sha=%s" % (
        t["id"], t["status"], (t["total_bytes"] or 0) / 2**30, t["avg_MiB_s"], t["speed_p50_MiB_s"],
        t["speed_p95_MiB_s"], t["peak_workers"] or 0, t["samples"], t["sample_span_s"] or 0,
        t["max_stalled_ms"], t["verified"], (t["sha256"] or "")[:12]))
    print("     workers:", [(w["workers"], w["ts"][11:19]) for w in t["worker_changes"]][:16])
