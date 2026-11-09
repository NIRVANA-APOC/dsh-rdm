#!/usr/bin/env python3
"""Analyze dsh-rdm kernel download history (JSONL) without dependencies.

Reads the per-task recordings written by the resident kernel under
``<dataDir>/history/<taskId>.samples.jsonl`` and
``<dataDir>/history/<taskId>.events.jsonl`` (protocol 2, kernel 0.2.1+), and
optionally host-side progress JSONL (``.progress.jsonl`` from the live
download harness).  Prints a per-task summary and can emit machine-readable
CSV/JSON.

What it reports per task
------------------------
* sample count, span, cadence (mean Hz, max gap)
* cumulative byte range (first -> last sample, delta)
* bps mean/p50/p95/p99/max in MiB/s (first sample excluded by default because a
  resumed task starts with a one-sample rate spike; ``--include-first`` keeps it)
* worker count min/max, peakWorkers
* controller event counts by action (grow/revert/shrink/backoff/rebuild/other)
* retry count and tail-stall count (``no body data ... stalled connection``)
* kernel builds seen (0.2.2 ``kind:"meta"`` records: kernelVersion@pid, run,
  resumedBytes, resumeDecision).  Older histories have no meta lines and are
  reported as ``pre-1.2.0 (no meta)``.

Usage
-----
    python scripts/analyze_history.py session_logs/20261109/telemetry-kernel
    python scripts/analyze_history.py "D:/llm/models/.dsh-rdm-data" --json out.json
    python scripts/analyze_history.py .tmp/live-qwen36/q4.progress.jsonl --csv q4.csv
    python scripts/analyze_history.py <dir> <file> --tz +08:00 --include-first

Each positional input may be:
* a kernel data directory (``<input>/history/*.samples.jsonl`` + ``*.events.jsonl``),
* a directory containing ``*.samples.jsonl`` / ``*.events.jsonl`` directly,
* a ``*.samples.jsonl`` / ``*.events.jsonl`` file (its sibling is picked up),
* any JSONL file of host progress records (``downloaded``/``speedBps`` keys).

Records are classified by their fields, so a partially-written last line is
skipped rather than crashing (``skipped_lines`` in the JSON output).

Exit codes: 0 = analyzed at least one task; 2 = no inputs usable.
"""

from __future__ import annotations

import argparse
import csv
import glob
import json
import os
import statistics
import sys
from datetime import datetime, timedelta, timezone

MIB = 1024.0 * 1024.0
# Kernel history `t` is epoch milliseconds; host progress `t` is epoch seconds.
MS_THRESHOLD = 1e11

SAMPLES_SUFFIX = ".samples.jsonl"
EVENTS_SUFFIX = ".events.jsonl"


# ---------------------------------------------------------------------------
# loading
# ---------------------------------------------------------------------------

def _read_jsonl(path):
    """Yield parsed objects from a JSONL file; count unreadable/partial lines."""
    ok = 0
    bad = 0
    with open(path, "r", encoding="utf-8", errors="replace") as handle:
        for line in handle:
            line = line.strip()
            if not line:
                continue
            try:
                obj = json.loads(line)
            except (ValueError, TypeError):
                bad += 1
                continue
            if isinstance(obj, dict):
                ok += 1
                yield obj, None
            else:
                bad += 1
    yield None, {"path": path, "bad_lines": bad}


def _t_ms(value):
    """Normalize epoch seconds/milliseconds to integer milliseconds."""
    if value is None:
        return None
    number = float(value)
    if number < MS_THRESHOLD:
        number *= 1000.0
    return int(round(number))


def _classify(obj):
    """Classify one JSONL record."""
    if obj.get("kind") == "meta":
        return "meta"
    if "bytes" in obj:
        return "kernel-sample"
    if "downloaded" in obj:
        return "host-sample"
    if "kind" in obj and ("seq" in obj or "message" in obj):
        return "kernel-event"
    if "kind" in obj:  # host status/progress marker without counters
        return "host-event"
    return "unknown"


def _normalize_sample(obj, fmt):
    stalled = obj.get("stalledMs", obj.get("stalled_ms", 0)) or 0
    peak = obj.get("peakWorkers", obj.get("peak_workers"))
    if fmt == "kernel-sample":
        return {
            "t": _t_ms(obj.get("t")),
            "bytes": int(obj.get("bytes", 0)),
            "transferred": _num(obj.get("transferred"), int),
            "bps": _num(obj.get("bps")),
            "workers": _num(obj.get("workers"), int),
            "peak_workers": _num(peak, int),
            "stalled_ms": int(stalled),
        }
    return {
        "t": _t_ms(obj.get("t")),
        "bytes": int(obj.get("downloaded", 0)),
        "transferred": None,
        "bps": _num(obj.get("speedBps")),
        "workers": _num(obj.get("activeWorkers"), int),
        "peak_workers": _num(peak, int),
        "stalled_ms": int(stalled),
    }


def _normalize_event(obj):
    return {
        "t": _t_ms(obj.get("t")),
        "kind": str(obj.get("kind", "?")),
        "message": obj.get("message") or "",
        "chunk": obj.get("chunk"),
        "attempt": obj.get("attempt"),
        "delay_ms": obj.get("delay_ms", obj.get("delayMs")),
    }


def _num(value, cast=float):
    if value is None:
        return None
    try:
        return cast(value)
    except (TypeError, ValueError):
        return None


# ---------------------------------------------------------------------------
# discovery
# ---------------------------------------------------------------------------

def _collect_inputs(paths):
    """Return (sample_files: [(path, task_hint|None)], event_files) deduped."""
    sample_files = []
    event_files = []
    seen = set()

    def add_sample(path, hint=None):
        path = os.path.abspath(path)
        if path not in seen:
            seen.add(path)
            sample_files.append((path, hint))

    def add_event(path, hint=None):
        path = os.path.abspath(path)
        if path not in seen:
            seen.add(path)
            event_files.append((path, hint))

    def hint_from(path):
        name = os.path.basename(path)
        for suffix in (SAMPLES_SUFFIX, EVENTS_SUFFIX, ".progress.jsonl", ".jsonl"):
            if name.endswith(suffix):
                return name[: -len(suffix)]
        return None

    for raw in paths:
        path = os.path.abspath(raw)
        if os.path.isdir(path):
            # 1) kernel data dir: <dir>/history/*.jsonl
            history = os.path.join(path, "history")
            roots = [history] if os.path.isdir(history) else [path]
            for root in roots:
                for name in sorted(os.listdir(root)):
                    full = os.path.join(root, name)
                    if not os.path.isfile(full):
                        continue
                    if name.endswith(SAMPLES_SUFFIX):
                        add_sample(full, hint_from(name))
                    elif name.endswith(EVENTS_SUFFIX):
                        add_event(full, hint_from(name))
                    elif name.endswith(".progress.jsonl") or name.endswith(".jsonl") and "progress" in name:
                        add_sample(full, hint_from(name))
            if roots == [history]:
                continue
            # 2) also accept the history dir itself as input
            if os.path.basename(path) == "history":
                continue
        elif os.path.isfile(path):
            if path.endswith(SAMPLES_SUFFIX):
                add_sample(path, hint_from(os.path.basename(path)))
            elif path.endswith(EVENTS_SUFFIX):
                add_event(path, hint_from(os.path.basename(path)))
                sibling = path[: -len(EVENTS_SUFFIX)] + SAMPLES_SUFFIX
                if os.path.isfile(sibling):
                    add_sample(sibling, hint_from(os.path.basename(sibling)))
            else:
                add_sample(path, hint_from(os.path.basename(path)))
        else:
            print("warning: input not found: %s" % raw, file=sys.stderr)
    return sample_files, event_files


# ---------------------------------------------------------------------------
# aggregation
# ---------------------------------------------------------------------------

def _percentile(values, q):
    if not values:
        return None
    ordered = sorted(values)
    pos = (len(ordered) - 1) * q
    low = int(pos)
    high = min(low + 1, len(ordered) - 1)
    frac = pos - low
    return ordered[low] * (1.0 - frac) + ordered[high] * frac


def _fmt_ts(t_ms, tz):
    if t_ms is None:
        return "unknown"
    stamp = datetime.fromtimestamp(t_ms / 1000.0, tz)
    return stamp.strftime("%Y-%m-%dT%H:%M:%S.") + "%03d%s" % (
        stamp.microsecond // 1000,
        stamp.strftime("%z"),
    )


def _fmt_int(value):
    return "n/a" if value is None else "{:,}".format(int(value))


def _fmt_mib(value):
    if value is None:
        return "n/a"
    return "%.2f" % (value / MIB)


FORMAT_LABEL = {
    "kernel-sample": "kernel-history",
    "host-sample": "host-progress",
}


def _empty_task(source, fmt):
    return {
        "source": source,
        "format": FORMAT_LABEL.get(fmt, fmt),
        "samples": [],
        "events": [],
        "meta": [],
        "skipped": 0,
    }


def build_report(sample_files, event_files, tz, exclude_leading):
    tasks = {}

    def bucket(task_id, source, fmt):
        entry = tasks.get(task_id)
        label = FORMAT_LABEL.get(fmt, fmt)
        if entry is None:
            entry = _empty_task(source, fmt)
            entry["sources"] = [source]
            tasks[task_id] = entry
        else:
            if source not in entry["sources"]:
                entry["sources"].append(source)
            if entry["format"] != label:
                entry["format"] = entry["format"] + "+" + label
        return entry

    for path, hint in sample_files:
        fmt = None
        record_task = hint
        entry = None
        bad = 0
        for obj, footer in _read_jsonl(path):
            if footer is not None:
                bad = footer.get("bad_lines", 0)
                continue
            kind = _classify(obj)
            if kind == "meta":
                task_id = str(obj.get("taskId") or record_task or hint or os.path.basename(path))
                entry = bucket(task_id, path, "kernel-history")
                entry["meta"].append(obj)
                continue
            if kind not in ("kernel-sample", "host-sample"):
                continue
            fmt = kind
            task_id = str(
                obj.get("taskId")
                or record_task
                or hint
                or os.path.basename(path).split(".")[0]
            )
            if entry is None or entry.get("_fmt_kind") != fmt:
                entry = bucket(task_id, path, fmt)
                entry["_fmt_kind"] = fmt
            entry["samples"].append(_normalize_sample(obj, fmt))
        if entry is not None:
            entry["skipped"] = entry.get("skipped", 0) + bad

    for path, hint in event_files:
        task_id = hint or os.path.basename(path)
        entry = None
        bad = 0
        for obj, footer in _read_jsonl(path):
            if footer is not None:
                bad = footer.get("bad_lines", 0)
                continue
            if _classify(obj) != "kernel-event":
                continue
            if entry is None:
                entry = bucket(task_id, path, "kernel-sample")
            entry["events"].append(_normalize_event(obj))
        if entry is not None:
            entry["skipped"] = entry.get("skipped", 0) + bad

    report_tasks = []
    for task_id in sorted(tasks):
        entry = tasks[task_id]
        samples = [s for s in entry["samples"] if s["t"] is not None]
        samples.sort(key=lambda item: item["t"])
        meta = entry["meta"]
        builds = []
        for record in meta:
            builds.append(
                {
                    "t": _t_ms(record.get("t")),
                    "kernelVersion": record.get("kernelVersion"),
                    "pid": record.get("pid"),
                    "run": record.get("run"),
                    "phase": record.get("phase"),
                    "totalBytes": record.get("totalBytes"),
                    "chunkSize": record.get("chunkSize"),
                    "chunks": record.get("chunks"),
                    "requestedConnections": record.get("requestedConnections"),
                    "initialWorkers": record.get("initialWorkers"),
                    "maxConnections": record.get("maxConnections"),
                    "resumedBytes": record.get("resumedBytes"),
                    "resumeDecision": record.get("resumeDecision"),
                    "resumeReason": record.get("resumeReason"),
                }
            )

        bps_all = [s["bps"] for s in samples if s["bps"] is not None]
        # A resumed task can start with a one-sample rate spike (the pre-0.2.2
        # baseline bug) whose EWMA tail inflates the next few samples too, so
        # callers can drop a leading run with --exclude-leading.
        excluded = min(exclude_leading, max(0, len(bps_all) - 1))
        stats_values = bps_all[excluded:]
        stats = {
            "mean": statistics.mean(stats_values) if stats_values else None,
            "p50": _percentile(stats_values, 0.50),
            "p95": _percentile(stats_values, 0.95),
            "p99": _percentile(stats_values, 0.99),
            "max": max(stats_values) if stats_values else None,
        }
        gaps = [samples[i]["t"] - samples[i - 1]["t"] for i in range(1, len(samples))]
        span_ms = samples[-1]["t"] - samples[0]["t"] if len(samples) > 1 else 0
        workers = [s["workers"] for s in samples if s["workers"] is not None]
        peaks = [s["peak_workers"] for s in samples if s["peak_workers"] is not None]

        controller = {
            "grow": 0,
            "revert": 0,
            "shrink": 0,
            "backoff": 0,
            "rebuild": 0,
            "freeze": 0,
            "unfreeze": 0,
            "tail_freeze": 0,
            "other": 0,
        }
        event_kinds = {}
        retries = 0
        tail_stalls = 0
        for event in entry["events"]:
            event_kinds[event["kind"]] = event_kinds.get(event["kind"], 0) + 1
            if event["kind"] == "retry":
                retries += 1
                if "no body data" in event["message"] or "stalled connection" in event["message"]:
                    tail_stalls += 1
            if event["kind"] != "controller":
                continue
            message = event["message"]
            if message.startswith("grow to "):
                controller["grow"] += 1
            elif message.startswith("revert to "):
                controller["revert"] += 1
            elif message.startswith("shrink to "):
                controller["shrink"] += 1
            elif message.startswith("backoff to "):
                controller["backoff"] += 1
            elif message.startswith("growth frozen"):
                controller["freeze"] += 1
            elif message.startswith("growth unfrozen"):
                controller["unfreeze"] += 1
            elif message.startswith("tail:"):
                controller["tail_freeze"] += 1
            elif "rebuild" in message:
                controller["rebuild"] += 1
            else:
                controller["other"] += 1

        transferred = [s["transferred"] for s in samples if s.get("transferred") is not None]
        # Per-run segments: split the sample timeline at history meta boundaries so
        # a session that spans several kernel builds/restarts can be attributed.
        runs = []
        if meta:
            boundaries = sorted((build for build in builds if build.get("t")), key=lambda build: build["t"])
            # Samples recorded before the first meta line are from a build that
            # did not write meta (e.g. 0.2.1): report them as their own segment.
            leading = [s for s in samples if s["t"] < boundaries[0]["t"]]
            if leading:
                seg_bps = [s["bps"] for s in leading if s["bps"] is not None]
                runs.append(
                    {
                        "build": "pre-meta (no meta record)",
                        "from_utc": _fmt_ts(leading[0]["t"], tz),
                        "to_utc": _fmt_ts(leading[-1]["t"], tz),
                        "samples": len(leading),
                        "bytes_delta": leading[-1]["bytes"] - leading[0]["bytes"],
                        "bps_mean": statistics.mean(seg_bps[1:] or seg_bps) if seg_bps else None,
                        "bps_max": max(seg_bps) if seg_bps else None,
                    }
                )
            for index, build in enumerate(boundaries):
                start = build["t"]
                end = boundaries[index + 1]["t"] if index + 1 < len(boundaries) else None
                seg = [
                    s
                    for s in samples
                    if s["t"] >= start and (end is None or s["t"] < end)
                ]
                if not seg:
                    continue
                seg_bps = [s["bps"] for s in seg if s["bps"] is not None]
                runs.append(
                    {
                        "build": "%s@pid%s" % (build.get("kernelVersion") or "?", build.get("pid") or "?"),
                        "from_utc": _fmt_ts(seg[0]["t"], tz),
                        "to_utc": _fmt_ts(seg[-1]["t"], tz),
                        "samples": len(seg),
                        "bytes_delta": seg[-1]["bytes"] - seg[0]["bytes"],
                        "bps_mean": statistics.mean(seg_bps[1:] or seg_bps) if seg_bps else None,
                        "bps_max": max(seg_bps) if seg_bps else None,
                    }
                )

        first_bps = bps_all[0] if bps_all else None
        median = _percentile(bps_all, 0.5) if bps_all else None
        spike_ratio = (first_bps / median) if first_bps and median else None
        build_labels = [
            "%s@pid%s" % (build.get("kernelVersion") or "?", build.get("pid") or "?")
            for build in builds
        ]
        if not build_labels:
            build_labels = ["pre-1.2.0 (no meta)"]

        report_tasks.append(
            {
                "task": task_id,
                "format": entry["format"],
                "sources": entry["sources"],
                "samples": len(samples),
                "skipped_lines": entry.get("skipped", 0),
                "span_s": span_ms / 1000.0 if samples else 0.0,
                "first_utc": _fmt_ts(samples[0]["t"], tz) if samples else None,
                "last_utc": _fmt_ts(samples[-1]["t"], tz) if samples else None,
                "first_t_ms": samples[0]["t"] if samples else None,
                "last_t_ms": samples[-1]["t"] if samples else None,
                "cadence_hz": ((len(samples) - 1) / (span_ms / 1000.0)) if span_ms > 0 else None,
                "max_gap_ms": max(gaps) if gaps else None,
                "bytes_first": samples[0]["bytes"] if samples else None,
                "bytes_last": samples[-1]["bytes"] if samples else None,
                "bytes_delta": (samples[-1]["bytes"] - samples[0]["bytes"]) if samples else None,
                "transferred_present": bool(transferred),
                "transferred_first": transferred[0] if transferred else None,
                "transferred_last": transferred[-1] if transferred else None,
                "transferred_delta": (transferred[-1] - transferred[0]) if transferred else None,
                "runs": runs,
                "bps_first": first_bps,
                "bps_first_excluded": excluded >= 1,
                "bps_leading_excluded": excluded,
                "bps_first_spike_ratio": spike_ratio,
                "bps_mean": stats["mean"],
                "bps_p50": stats["p50"],
                "bps_p95": stats["p95"],
                "bps_p99": stats["p99"],
                "bps_max": stats["max"],
                "workers_min": min(workers) if workers else None,
                "workers_max": max(workers) if workers else None,
                "peak_workers": max(peaks) if peaks else None,
                "controller": controller,
                "controller_total": sum(controller.values()),
                "event_kinds": event_kinds,
                "events": len(entry["events"]),
                "retries": retries,
                "tail_stalls": tail_stalls,
                "stalled_samples": sum(1 for s in samples if (s["stalled_ms"] or 0) >= 5000),
                "builds": build_labels,
                "build_meta": builds,
                "meta_present": bool(meta),
            }
        )
    return report_tasks


# ---------------------------------------------------------------------------
# output
# ---------------------------------------------------------------------------

def print_report(tasks, tz):
    print("dsh-rdm download-history analysis")
    print("=" * 78)
    if not tasks:
        print("no task recordings found")
        return
    total_samples = sum(task["samples"] for task in tasks)
    total_events = sum(task["events"] for task in tasks)
    total_ctrl = sum(task["controller_total"] for task in tasks)
    print(
        "tasks: %d  samples: %d  events: %d  controller events: %d"
        % (len(tasks), total_samples, total_events, total_ctrl)
    )
    all_builds = sorted({build for task in tasks for build in task["builds"]})
    print("builds seen: %s" % (", ".join(all_builds) if all_builds else "none"))
    print()
    for task in tasks:
        print("-" * 78)
        print(task["task"])
        print("  source   : %s" % " ; ".join(task["sources"]))
        print("  format   : %s%s" % (task["format"], "" if task["meta_present"] else "  (no meta/build records)"))
        print(
            "  samples  : %d   span: %.2f s   cadence: %s Hz   max gap: %s ms"
            % (
                task["samples"],
                task["span_s"],
                "--" if task["cadence_hz"] is None else "%.2f" % task["cadence_hz"],
                "n/a" if task["max_gap_ms"] is None else "%d" % task["max_gap_ms"],
            )
        )
        print("  first    : %s" % (task["first_utc"] or "n/a"))
        print("  last     : %s" % (task["last_utc"] or "n/a"))
        print(
            "  bytes    : %s -> %s  (delta %s)"
            % (
                _fmt_int(task["bytes_first"]),
                _fmt_int(task["bytes_last"]),
                _fmt_int(task["bytes_delta"]),
            )
        )
        if task["transferred_present"]:
            print(
                "  transferred: %s -> %s  (this-run delta %s)"
                % (
                    _fmt_int(task["transferred_first"]),
                    _fmt_int(task["transferred_last"]),
                    _fmt_int(task["transferred_delta"]),
                )
            )
        for run in task.get("runs") or []:
            print(
                "    run %s  %s .. %s  samples=%d  bytes_delta=%s  bps mean %s / max %s MiB/s"
                % (
                    run["build"],
                    run["from_utc"],
                    run["to_utc"],
                    run["samples"],
                    _fmt_int(run["bytes_delta"]),
                    _fmt_mib(run["bps_mean"]),
                    _fmt_mib(run["bps_max"]),
                )
            )
        print(
            "  bps MiB/s: mean %s  p50 %s  p95 %s  p99 %s  max %s  (%d leading sample(s) excluded)"
            % (
                _fmt_mib(task["bps_mean"]),
                _fmt_mib(task["bps_p50"]),
                _fmt_mib(task["bps_p95"]),
                _fmt_mib(task["bps_p99"]),
                _fmt_mib(task["bps_max"]),
                task["bps_leading_excluded"],
            )
        )
        if task["bps_first"] is not None:
            spike = (
                "  spike x%.1f vs median" % task["bps_first_spike_ratio"]
                if task["bps_first_spike_ratio"] and task["bps_first_spike_ratio"] > 5
                else ""
            )
            print("  bps[0]   : %.2f MiB/s%s" % (task["bps_first"] / MIB, spike))
        print(
            "  workers  : min %s  max %s  peakWorkers %s"
            % (
                "n/a" if task["workers_min"] is None else task["workers_min"],
                "n/a" if task["workers_max"] is None else task["workers_max"],
                "n/a" if task["peak_workers"] is None else task["peak_workers"],
            )
        )
        ctrl = task["controller"]
        print(
            "  controller: grow=%d revert=%d shrink=%d backoff=%d rebuild=%d freeze=%d unfreeze=%d tail_freeze=%d other=%d"
            % (
                ctrl["grow"],
                ctrl["revert"],
                ctrl["shrink"],
                ctrl["backoff"],
                ctrl["rebuild"],
                ctrl["freeze"],
                ctrl["unfreeze"],
                ctrl["tail_freeze"],
                ctrl["other"],
            )
        )
        kinds = ", ".join("%s=%d" % (kind, count) for kind, count in sorted(task["event_kinds"].items()))
        print("  events   : %d (%s)" % (task["events"], kinds or "none"))
        print("  retries  : %d   tail stalls (no body data): %d" % (task["retries"], task["tail_stalls"]))
        print("  builds   : %s" % ", ".join(task["builds"]))
        if task["skipped_lines"]:
            print("  warning  : skipped %d unreadable line(s)" % task["skipped_lines"])
        for index, build in enumerate(task["build_meta"]):
            print(
                "    build[%d] %s pid=%s run=%s phase=%s t=%s requested=%s initial=%s ceiling=%s resumedBytes=%s decision=%s%s"
                % (
                    index,
                    build.get("kernelVersion"),
                    build.get("pid"),
                    build.get("run"),
                    build.get("phase"),
                    _fmt_ts(build.get("t"), tz),
                    build.get("requestedConnections"),
                    build.get("initialWorkers"),
                    build.get("maxConnections"),
                    build.get("resumedBytes"),
                    build.get("resumeDecision"),
                    (" reason=%s" % build.get("resumeReason")) if build.get("resumeReason") else "",
                )
            )
    print("-" * 78)


CSV_FIELDS = [
    "task",
    "format",
    "samples",
    "span_s",
    "cadence_hz",
    "max_gap_ms",
    "first_utc",
    "last_utc",
    "bytes_first",
    "bytes_last",
    "bytes_delta",
    "bps_first",
    "bps_first_excluded",
    "bps_leading_excluded",
    "bps_first_spike_ratio",
    "bps_mean",
    "bps_p50",
    "bps_p95",
    "bps_p99",
    "bps_max",
    "workers_min",
    "workers_max",
    "peak_workers",
    "controller_grow",
    "controller_revert",
    "controller_shrink",
    "controller_backoff",
    "controller_rebuild",
    "controller_freeze",
    "controller_unfreeze",
    "controller_tail_freeze",
    "transferred_present",
    "transferred_first",
    "transferred_last",
    "transferred_delta",
    "events",
    "retries",
    "tail_stalls",
    "builds",
    "skipped_lines",
]


def _csv_row(task):
    row = {field: task.get(field) for field in CSV_FIELDS if field in task}
    row["controller_grow"] = task["controller"]["grow"]
    row["controller_revert"] = task["controller"]["revert"]
    row["controller_shrink"] = task["controller"]["shrink"]
    row["controller_backoff"] = task["controller"]["backoff"]
    row["controller_rebuild"] = task["controller"]["rebuild"]
    row["controller_freeze"] = task["controller"].get("freeze", 0)
    row["controller_unfreeze"] = task["controller"].get("unfreeze", 0)
    row["controller_tail_freeze"] = task["controller"].get("tail_freeze", 0)
    row["builds"] = ";".join(task["builds"])
    return row


def main(argv=None):
    parser = argparse.ArgumentParser(
        description="Summarize dsh-rdm kernel download-history JSONL (stdlib only).",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    parser.add_argument("inputs", nargs="+", help="kernel data dirs, history dirs, or JSONL files")
    parser.add_argument("--json", metavar="PATH", help="write machine-readable summary JSON")
    parser.add_argument("--csv", metavar="PATH", help="write one CSV row per task")
    parser.add_argument(
        "--exclude-leading",
        type=int,
        default=1,
        metavar="N",
        help="drop the first N samples from bps statistics (resume-spike guard; 0 keeps all)",
    )
    parser.add_argument(
        "--include-first",
        action="store_true",
        help="alias for --exclude-leading 0 (keep the possibly resume-inflated first samples)",
    )
    parser.add_argument(
        "--tz",
        default="+00:00",
        help="display timezone offset for timestamps, e.g. +08:00 (default UTC)",
    )
    args = parser.parse_args(argv)
    if args.include_first:
        args.exclude_leading = 0
    if args.exclude_leading < 0:
        parser.error("--exclude-leading must be >= 0")

    try:
        sign = -1 if args.tz.startswith("-") else 1
        hours, minutes = args.tz.lstrip("+-").split(":")
        tz = timezone(sign * timedelta(hours=int(hours), minutes=int(minutes) if minutes else 0))
    except (ValueError, AttributeError):
        parser.error("invalid --tz (expected e.g. +08:00)")

    sample_files, event_files = _collect_inputs(args.inputs)
    if not sample_files and not event_files:
        print("no kernel history files found in: %s" % ", ".join(args.inputs), file=sys.stderr)
        return 2

    tasks = build_report(sample_files, event_files, tz, args.exclude_leading)
    print_report(tasks, tz)

    if args.json:
        payload = {
            "generated_by": "scripts/analyze_history.py",
            "inputs": [os.path.abspath(item) for item in args.inputs],
            "sample_files": [path for path, _ in sample_files],
            "event_files": [path for path, _ in event_files],
            "exclude_leading_samples": args.exclude_leading,
            "tasks": tasks,
        }
        with open(args.json, "w", encoding="utf-8") as handle:
            json.dump(payload, handle, indent=2, ensure_ascii=False)
        print("wrote %s" % args.json)

    if args.csv:
        with open(args.csv, "w", encoding="utf-8", newline="") as handle:
            writer = csv.DictWriter(handle, fieldnames=CSV_FIELDS)
            writer.writeheader()
            for task in tasks:
                writer.writerow(_csv_row(task))
        print("wrote %s" % args.csv)

    return 0


if __name__ == "__main__":
    sys.exit(main())
