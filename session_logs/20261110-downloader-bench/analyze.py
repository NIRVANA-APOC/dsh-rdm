import json
import os
import statistics

ROOT = r"C:\Users\nirvana\Documents\deepseek-harness\dsh-rdm"
LOG = os.path.join(ROOT, "session_logs", "20261110-downloader-bench")
FINAL = os.path.join(LOG, "results-final.json")
LARGE = os.path.join(LOG, "results-large-3.json")

with open(FINAL, encoding="utf-8") as handle:
    final = json.load(handle)
with open(LARGE, encoding="utf-8") as handle:
    large = json.load(handle)

rows = [row for row in final["rows"] if row["task"] != "large"]
rows += [row for row in final["rows"] if row["task"] == "large"]
rows += [row for row in large["rows"] if row["task"] == "large"]
rows.sort(key=lambda row: (["small", "medium", "large", "redirect"].index(row["task"]), row["tool"], row["run"]))

by_task = {}
for row in rows:
    by_task.setdefault(row["task"], {}).setdefault(row["tool"], []).append(row)

summary = []
for task, tools in by_task.items():
    for tool, values in tools.items():
        walls = sorted(value["wall_s"] for value in values)
        speeds = sorted(value["speed_mib_s"] for value in values)
        cpus = sorted(value["cpu_s"] for value in values)
        rss = [value["rss_mb"] for value in values]
        summary.append(
            {
                "task": task,
                "label": values[0]["label"],
                "tool": tool,
                "runs": len(values),
                "verified": sum(1 for value in values if value["verified"]),
                "wall_median": round(statistics.median(walls), 3),
                "wall_min": round(min(walls), 3),
                "wall_max": round(max(walls), 3),
                "wall_mean": round(statistics.mean(walls), 3),
                "speed_median": round(statistics.median(speeds), 2),
                "speed_min": round(min(speeds), 2),
                "speed_max": round(max(speeds), 2),
                "cpu_median": round(statistics.median(cpus), 3),
                "cpu_pct_median": round(statistics.median(value["cpu_pct"] for value in values), 1),
                "rss_peak": round(max(rss), 1),
                "peak_workers": max((value.get("peak_workers") or 0) for value in values),
            }
        )

with open(os.path.join(LOG, "summary.json"), "w", encoding="utf-8") as handle:
    json.dump(summary, handle, ensure_ascii=False, indent=2)

with open(os.path.join(LOG, "rows.csv"), "w", encoding="utf-8") as handle:
    fields = ["task", "tool", "run", "wall_s", "bytes", "speed_mib_s", "cpu_s", "cpu_pct", "rss_mb", "peak_workers", "verified"]
    handle.write(",".join(fields) + "\n")
    for row in rows:
        handle.write(",".join(str(row[field]) for field in fields) + "\n")

print(f"{'task':9} {'tool':13} {'n':>2} {'verify':>6} {'wall med':>9} {'min':>7} {'max':>7} {'MiB/s':>7} {'cpu s':>6} {'cpu %':>6} {'rss MB':>7} {'workers':>7}")
for item in summary:
    print(
        f"{item['task']:9} {item['tool']:13} {item['runs']:2d} {item['verified']:6d} "
        f"{item['wall_median']:9.3f} {item['wall_min']:7.3f} {item['wall_max']:7.3f} "
        f"{item['speed_median']:7.2f} {item['cpu_median']:6.3f} {item['cpu_pct_median']:6.1f} "
        f"{item['rss_peak']:7.1f} {item['peak_workers']:7d}"
    )

print("\nrelative to aria2 (wall reduction; positive = faster):")
for task in ["small", "medium", "large", "redirect"]:
    tools = {item["tool"]: item for item in summary if item["task"] == task}
    aria = tools.get("aria2")
    if aria is None:
        continue
    for tool, item in tools.items():
        if tool == "aria2":
            continue
        reduction = (aria["wall_median"] - item["wall_median"]) / aria["wall_median"] * 100
        speed_delta = (item["speed_median"] - aria["speed_median"]) / aria["speed_median"] * 100
        print(f"{task:9} {tool:13} wall {reduction:+6.1f}%  speed {speed_delta:+6.1f}%")
