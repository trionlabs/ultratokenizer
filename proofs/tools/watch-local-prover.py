#!/usr/bin/env python3
"""Run an explicit local prover command with aggregate RSS and wall-time limits.

The watchdog observes the command and its descendants; it never reads documents.
Core proofs can disclose witness data and belong in a private output directory.
"""
import argparse
import json
import os
import signal
import subprocess
import time


def process_rss(root: int) -> int:
    result = subprocess.run(["ps", "-axo", "pid=,ppid=,rss="], capture_output=True, text=True, check=True)
    rows = [tuple(map(int, line.split())) for line in result.stdout.splitlines()]
    descendants = {root}
    while True:
        expanded = descendants | {pid for pid, parent, _ in rows if parent in descendants}
        if expanded == descendants:
            return sum(rss for pid, _, rss in rows if pid in descendants) * 1024
        descendants = expanded


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--seconds", type=int, default=180)
    parser.add_argument("--max-rss-mib", type=int, default=4096)
    parser.add_argument("command", nargs=argparse.REMAINDER)
    args = parser.parse_args()
    command = args.command[1:] if args.command[:1] == ["--"] else args.command
    if not command or args.seconds < 1 or args.max_rss_mib < 1:
        parser.error("A command and positive resource limits are required.")
    environment = os.environ.copy()
    environment.update({
        "RAYON_NUM_THREADS": "2", "TOKIO_WORKER_THREADS": "2",
        "SP1_WORKER_NUM_CORE_WORKERS": "1", "SP1_WORKER_NUM_SETUP_WORKERS": "1",
        "SP1_WORKER_NUM_SPLICING_WORKERS": "1", "SP1_WORKER_NUM_RECURSION_PROVER_WORKERS": "1",
        "SP1_WORKER_NUM_RECURSION_EXECUTOR_WORKERS": "1", "SP1_WORKER_NUM_PREPARE_REDUCE_WORKERS": "1",
    })
    started = time.monotonic()
    peak = 0
    reason = None
    process = subprocess.Popen(command, env=environment, start_new_session=True)
    try:
        while process.poll() is None:
            peak = max(peak, process_rss(process.pid))
            elapsed = time.monotonic() - started
            if peak > args.max_rss_mib * 1024 * 1024:
                reason = "aggregate_rss_limit"
                break
            if elapsed > args.seconds:
                reason = "wall_time_limit"
                break
            time.sleep(1)
    except BaseException:
        reason = "watchdog_interrupted"
        raise
    finally:
        if process.poll() is None:
            os.killpg(process.pid, signal.SIGTERM)
            try:
                process.wait(timeout=3)
            except subprocess.TimeoutExpired:
                os.killpg(process.pid, signal.SIGKILL)
                process.wait()
        print(json.dumps({
            "watchdog": "stopped" if reason else "completed", "reason": reason,
            "peakAggregateRssMiB": round(peak / 1024 / 1024, 1),
            "elapsedSeconds": round(time.monotonic() - started, 2), "exitCode": process.returncode,
        }), flush=True)
    raise SystemExit(1 if reason else process.returncode)


if __name__ == "__main__":
    main()
