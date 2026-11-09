"""Write tasks.json: the four kernel task records verbatim, plus the coverage map
(which task has a kernel history recording and from when) and the export metadata."""
import json
import pathlib
from datetime import datetime

OUT = pathlib.Path(r"D:\llm\rdm-record")
RDM = pathlib.Path(r"C:\Users\nirvana\Documents\deepseek-harness\dsh-rdm\.rdm-data")
IDS = ["t_248a5911009cc18d", "t_7359f357ea3922cb", "t_6a665d4e17fa3100", "t_ebda50bb99a77a14"]
MiB = 1024.0 * 1024.0


def main():
    hist = json.loads((OUT / "kernel-history.json").read_text(encoding="utf-8"))
    tasks = []
    for tid in IDS:
        p = RDM / "tasks" / ("%s.json" % tid)
        rec = json.loads(p.read_text(encoding="utf-8"))
        tasks.append(rec)
    doc = {
        "exported": datetime.now().astimezone().isoformat(timespec="seconds"),
        "session": "session-cf09812a-9a90-43db-b42c-827303a6c053",
        "kernel": {
            "version": "1.1.0",
            "builds": [
                {"pid": 53520, "from": "2026-11-09T12:05:33+08:00", "to": "2026-11-09T12:12:09+08:00",
                 "note": "old build: no <data-dir>/history, rdm_history -> unknown method history, fixed worker pool"},
                {"pid": 59852, "from": "2026-11-09T12:13:00+08:00",
                 "note": "new build (bin/win32-x64/rdm-kernel.exe, 5,059,072 B, mtime 12:17:53): history/*.jsonl, "
                         "targetWorkers/resumedBytes fields, controller grow/revert/pool rebuild/shrink"},
            ],
            "data_dir": str(RDM),
        },
        "coverage": {
            "kernel_history": {k: {"samples": v["samples"], "events": v["events"],
                                  "from": v["first_sample"], "to": v["last_sample"]} for k, v in hist.items()},
            "external_sampler": {"interval_s": 2, "from": "2026-11-09T12:14:05+08:00",
                                 "to": "2026-11-09T12:20:16+08:00", "rows": 740,
                                 "file": "samples.jsonl"},
            "gaps": [
                "t_248a5911009cc18d (mmproj): no kernel history (finished before the new build); aggregates only",
                "t_7359f357ea3922cb (shard 2): 2 samples, both after the 12:12:09 restart; the pre-restart transfer has no series",
                "t_6a665d4e17fa3100 (shard 1 attempt 1): 376 samples, from the restart on (12:12:39-12:13:38); "
                "the 12:05:50-12:12:09 phase has aggregates only (avg 5.7 MiB/s, peak 13.4, 12 workers, origin-slow)",
            ],
        },
        "tasks": tasks,
    }
    (OUT / "tasks.json").write_text(json.dumps(doc, ensure_ascii=False, indent=2), encoding="utf-8")
    print("tasks.json:", len(tasks), "records")


if __name__ == "__main__":
    main()
