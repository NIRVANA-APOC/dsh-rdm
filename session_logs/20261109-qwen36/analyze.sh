#!/usr/bin/env bash
# Analyze the Qwen3.6 live-download package with the dependency-free analyzer.
#
# Usage:
#   ./analyze.sh                  # per-task summary of history/ (kernel JSONL)
#   ./analyze.sh --progress       # also summarize the host progress JSONL
#   ./analyze.sh --json out.json  # extra analyzer flags are passed through
#
# Regenerating metrics.json (from the repo root):
#   python .design/20261109-qwen36-metrics.py
set -euo pipefail
cd "$(dirname "$0")"
ROOT="$(cd ../.. && pwd)"

progress=0
args=()
for arg in "$@"; do
    if [ "$arg" = "--progress" ]; then
        progress=1
    else
        args+=("$arg")
    fi
done

echo "== kernel history (history/*.samples.jsonl + *.events.jsonl) =="
( cd "$ROOT" && python scripts/analyze_history.py session_logs/20261109-qwen36 --tz +08:00 ${args[@]+"${args[@]}"} )

if [ "$progress" = 1 ]; then
    echo
    echo "== host progress JSONL =="
    ( cd "$ROOT" && python scripts/analyze_history.py session_logs/20261109-qwen36/progress --tz +08:00 )
fi
