#!/usr/bin/env python3
"""Atomic checkout lease for the three Librarian AGENT-TEAM objectives.

One JSON file under .git/ coordinates the shared checkout: claim before any
mutation, prove the upstream base is unchanged before edits and push, and
release only after the checkout is clean and synchronized. Stdlib only; run
with python3, no uv environment required.
"""

from __future__ import annotations

import argparse
import json
import os
import socket
import subprocess
import sys
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
LEASE_PATH = REPO / ".git" / "agent-team-lease.json"
OBJECTIVES = ("archive", "improve", "run")
LEGACY_HOLDER_ID = "legacy-unidentified"


def now() -> datetime:
    return datetime.now(timezone.utc).replace(microsecond=0)


def git(*args: str) -> str:
    return subprocess.run(
        ["git", *args], cwd=REPO, check=True, capture_output=True, text=True
    ).stdout.strip()


def fetch_origin() -> None:
    result = subprocess.run(
        ["git", "fetch", "origin", "--prune"],
        cwd=REPO,
        check=False,
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        raise SystemExit("git fetch origin failed; upstream state is unknown")


def process_exists(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


def require_clean_checkout() -> None:
    if git("status", "--porcelain"):
        raise SystemExit("refusing while the worktree is dirty")


def require_main_origin() -> None:
    branch = git("rev-parse", "--abbrev-ref", "HEAD")
    if branch != "main":
        raise SystemExit(f"refusing outside main (on {branch})")
    try:
        upstream = git("rev-parse", "--abbrev-ref", "@{upstream}")
    except subprocess.CalledProcessError as exc:
        raise SystemExit("main has no upstream") from exc
    if upstream != "origin/main":
        raise SystemExit(f"main tracks {upstream}, not origin/main")


def is_ancestor(ancestor: str, descendant: str) -> bool:
    return (
        subprocess.run(
            ["git", "merge-base", "--is-ancestor", ancestor, descendant],
            cwd=REPO,
            check=False,
            capture_output=True,
            text=True,
        ).returncode
        == 0
    )


def read_lease() -> dict | None:
    try:
        return json.loads(LEASE_PATH.read_text())
    except FileNotFoundError:
        return None
    except (json.JSONDecodeError, OSError) as exc:
        raise SystemExit(f"lease file is unreadable; inspect {LEASE_PATH}: {exc}")


def claim(
    objective: str,
    *,
    current_time: datetime | None = None,
    holder_id: str | None = None,
    holder_pid: int | None = None,
    hostname: str | None = None,
    starting_head: str | None = None,
    lease_id: str | None = None,
) -> dict:
    if objective not in OBJECTIVES:
        raise SystemExit(f"unknown objective {objective!r}")
    lease = {
        "objective": objective,
        "lease_id": lease_id or str(uuid.uuid4()),
        "holder_id": holder_id or os.getenv("CODEX_THREAD_ID") or "untracked-manual-holder",
        "hostname": hostname or socket.gethostname(),
        "starting_head": starting_head or git("rev-parse", "HEAD"),
        "claimed_at": (current_time or now()).isoformat().replace("+00:00", "Z"),
    }
    if holder_pid is not None:
        lease["holder_pid"] = holder_pid
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


def check_base(objective: str, lease_id: str) -> dict:
    lease = check(objective, lease_id)
    require_clean_checkout()
    fetch_origin()
    require_main_origin()
    starting_head = lease.get("starting_head") or lease.get("starting_commit")
    if not isinstance(starting_head, str) or not starting_head:
        raise SystemExit("lease has no valid starting_head; inspect it manually")
    remote_head = git("rev-parse", "origin/main")
    if remote_head != starting_head:
        raise SystemExit("origin/main moved after the lease was claimed; do not push")
    current_head = git("rev-parse", "HEAD")
    if not is_ancestor(starting_head, current_head):
        raise SystemExit("current HEAD is not descended from the leased starting_head")
    return lease


def release(objective: str, lease_id: str) -> None:
    check(objective, lease_id)
    require_clean_checkout()
    fetch_origin()
    require_main_origin()
    if git("rev-parse", "HEAD") != git("rev-parse", "origin/main"):
        raise SystemExit("refusing to release until HEAD is synchronized with origin/main")
    LEASE_PATH.unlink()


def clear_stale(hours: float, *, current_time: datetime | None = None) -> dict:
    lease = read_lease()
    if lease is None:
        raise SystemExit("no lease is held")
    try:
        claimed = datetime.fromisoformat(str(lease["claimed_at"]).replace("Z", "+00:00"))
    except KeyError, ValueError:
        raise SystemExit("lease has no valid claimed_at; inspect it manually")
    age = (current_time or now()) - claimed
    if age < timedelta(hours=hours):
        raise SystemExit(f"lease is only {age} old; stale threshold is {hours}h")
    require_clean_checkout()
    starting_head = lease.get("starting_head") or lease.get("starting_commit")
    if starting_head != git("rev-parse", "HEAD"):
        raise SystemExit("refusing automatic stale clear because HEAD changed; inspect manually")
    lease_hostname = lease.get("hostname") or lease.get("host")
    if lease_hostname != socket.gethostname():
        raise SystemExit("lease was claimed on another host; cannot prove it is dead")
    pid = lease.get("holder_pid")
    if not isinstance(pid, int):
        raise SystemExit("lease records no durable holder pid; inspect it manually")
    if process_exists(pid):
        raise SystemExit(f"holder process {pid} is still running")
    LEASE_PATH.unlink()
    return lease


def clear_manual(holder_id: str, confirm_inactive: bool) -> dict:
    lease = read_lease()
    if lease is None:
        raise SystemExit("no lease is held")
    if not confirm_inactive:
        raise SystemExit("manual clear requires --confirm-inactive")
    recorded = lease.get("holder_id") or LEGACY_HOLDER_ID
    if recorded != holder_id:
        raise SystemExit(f"lease holder is {recorded!r}, not {holder_id!r}")
    require_clean_checkout()
    LEASE_PATH.unlink()
    return lease


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    p_claim = sub.add_parser("claim")
    p_claim.add_argument("objective", choices=OBJECTIVES)
    p_claim.add_argument("--holder-id")
    p_claim.add_argument("--holder-pid", type=int)
    for name in ("check", "check-base", "release"):
        p = sub.add_parser(name)
        p.add_argument("objective", choices=OBJECTIVES)
        p.add_argument("--lease-id", required=True)
    p_stale = sub.add_parser("clear-stale")
    p_stale.add_argument("--hours", type=float, default=8.0)
    p_manual = sub.add_parser("clear-manual")
    p_manual.add_argument("--holder-id", required=True)
    p_manual.add_argument("--confirm-inactive", action="store_true")
    sub.add_parser("status")
    args = parser.parse_args(argv)

    if args.command == "claim":
        print(
            json.dumps(
                claim(
                    args.objective,
                    holder_id=args.holder_id,
                    holder_pid=args.holder_pid,
                ),
                sort_keys=True,
            )
        )
    elif args.command == "check":
        print(json.dumps(check(args.objective, args.lease_id), sort_keys=True))
    elif args.command == "check-base":
        print(json.dumps(check_base(args.objective, args.lease_id), sort_keys=True))
    elif args.command == "release":
        release(args.objective, args.lease_id)
        print("released")
    elif args.command == "clear-stale":
        print(json.dumps(clear_stale(args.hours), sort_keys=True))
    elif args.command == "clear-manual":
        print(
            json.dumps(
                clear_manual(args.holder_id, args.confirm_inactive),
                sort_keys=True,
            )
        )
    else:  # status
        lease = read_lease()
        print(json.dumps(lease, sort_keys=True) if lease else "no lease held")
    return 0


if __name__ == "__main__":
    sys.exit(main())
