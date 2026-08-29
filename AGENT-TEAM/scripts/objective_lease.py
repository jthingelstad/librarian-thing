#!/usr/bin/env python3
"""Local checkout lease for the three Librarian AGENT-TEAM objectives.

One JSON file under .git/ coordinates the shared checkout: claim before any
mutation, check before edits and before push, release when the tree is clean.
Stdlib only; run with python3, no uv environment required.
"""

from __future__ import annotations

import argparse
import json
import os
import secrets
import socket
import subprocess
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
LEASE_PATH = REPO / ".git" / "agent-team-lease.json"
OBJECTIVES = ("archive", "improve", "run")


def now() -> datetime:
    return datetime.now(timezone.utc).replace(microsecond=0)


def head_commit() -> str:
    out = subprocess.run(
        ["git", "rev-parse", "HEAD"], cwd=REPO, check=True, capture_output=True, text=True
    )
    return out.stdout.strip()


def read_lease() -> dict | None:
    try:
        return json.loads(LEASE_PATH.read_text())
    except FileNotFoundError:
        return None
    except (json.JSONDecodeError, OSError) as exc:
        raise SystemExit(f"lease file is unreadable; inspect {LEASE_PATH}: {exc}")


def claim(objective: str) -> dict:
    host = socket.gethostname()
    lease = {
        "objective": objective,
        "lease_id": secrets.token_hex(8),
        "holder_id": f"{host}:{os.getpid()}:{secrets.token_hex(4)}",
        "holder_pid": os.getpid(),
        "host": host,
        "starting_commit": head_commit(),
        "claimed_at": now().isoformat().replace("+00:00", "Z"),
    }
    try:
        fd = os.open(LEASE_PATH, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    except FileExistsError:
        held = read_lease() or {}
        raise SystemExit(
            f"lease already held by objective {held.get('objective')!r} "
            f"(holder {held.get('holder_id')!r}, claimed {held.get('claimed_at')!r})"
        )
    with os.fdopen(fd, "w", encoding="utf-8") as handle:
        json.dump(lease, handle, indent=2, sort_keys=True)
        handle.write("\n")
    return lease


def check(objective: str, lease_id: str) -> dict:
    lease = read_lease()
    if lease is None:
        raise SystemExit("no lease is held")
    if lease.get("objective") != objective:
        raise SystemExit(f"lease belongs to objective {lease.get('objective')!r}")
    if lease.get("lease_id") != lease_id:
        raise SystemExit("lease belongs to a different run (lease_id mismatch)")
    return lease


def release(objective: str, lease_id: str) -> None:
    check(objective, lease_id)
    LEASE_PATH.unlink()


def clear_stale(hours: float) -> dict:
    lease = read_lease()
    if lease is None:
        raise SystemExit("no lease is held")
    try:
        claimed = datetime.fromisoformat(str(lease["claimed_at"]).replace("Z", "+00:00"))
    except KeyError, ValueError:
        raise SystemExit("lease has no valid claimed_at; inspect it manually")
    age = now() - claimed
    if age < timedelta(hours=hours):
        raise SystemExit(f"lease is only {age} old; stale threshold is {hours}h")
    if lease.get("host") != socket.gethostname():
        raise SystemExit("lease was claimed on another host; cannot prove it is dead")
    pid = lease.get("holder_pid")
    if not isinstance(pid, int):
        raise SystemExit("lease records no holder pid; inspect it manually")
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        pass  # holder process is gone; safe to clear
    except PermissionError:
        raise SystemExit(f"holder process {pid} still exists")
    else:
        raise SystemExit(f"holder process {pid} is still running")
    LEASE_PATH.unlink()
    return lease


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    p_claim = sub.add_parser("claim")
    p_claim.add_argument("objective", choices=OBJECTIVES)
    for name in ("check", "release"):
        p = sub.add_parser(name)
        p.add_argument("objective", choices=OBJECTIVES)
        p.add_argument("--lease-id", required=True)
    p_stale = sub.add_parser("clear-stale")
    p_stale.add_argument("--hours", type=float, required=True)
    sub.add_parser("status")
    args = parser.parse_args(argv)

    if args.command == "claim":
        print(json.dumps(claim(args.objective), sort_keys=True))
    elif args.command == "check":
        print(json.dumps(check(args.objective, args.lease_id), sort_keys=True))
    elif args.command == "release":
        release(args.objective, args.lease_id)
        print("released")
    elif args.command == "clear-stale":
        print(json.dumps(clear_stale(args.hours), sort_keys=True))
    else:  # status
        lease = read_lease()
        print(json.dumps(lease, sort_keys=True) if lease else "no lease held")
    return 0


if __name__ == "__main__":
    sys.exit(main())
