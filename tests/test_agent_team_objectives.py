from __future__ import annotations

import importlib.util
import sys
import tomllib
from datetime import datetime, timezone
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]


def load_module(name: str, relative: str):
    spec = importlib.util.spec_from_file_location(name, ROOT / relative)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


objective_lease = load_module("librarian_objective_lease", "AGENT-TEAM/scripts/objective_lease.py")


def test_registry_has_three_active_objective_owners():
    plan = tomllib.loads((ROOT / "AGENT-TEAM/automations.toml").read_text())
    entries = plan["automation"]

    assert plan["version"] == 2
    assert plan["repo"] == "."
    assert plan["timezone"] == "America/Chicago"
    assert len(entries) == 3
    assert {entry["objective"] for entry in entries} == {"run", "archive", "improve"}
    assert all(entry["status"] == "ACTIVE" for entry in entries)
    assert all(entry["execution_environment"] == "local" for entry in entries)
    assert all((ROOT / entry["objective_file"]).is_file() for entry in entries)
    assert {entry["id"] for entry in entries} == {
        "run-the-librarian",
        "keep-the-archive-true",
        "improve-thingy",
    }
    assert {entry["objective"]: entry["rrule"] for entry in entries} == {
        "run": "RRULE:FREQ=WEEKLY;BYHOUR=8;BYMINUTE=20;BYDAY=SA",
        "archive": "RRULE:FREQ=WEEKLY;BYHOUR=7;BYMINUTE=30;BYDAY=SU",
        "improve": "RRULE:FREQ=WEEKLY;BYHOUR=9;BYMINUTE=0;BYDAY=MO",
    }


def test_automation_prompts_preserve_the_common_contract():
    plan = tomllib.loads((ROOT / "AGENT-TEAM/automations.toml").read_text())
    for entry in plan["automation"]:
        prompt = entry["prompt"]
        assert f"`{entry['objective']}` objective" in prompt
        assert "Measure current evidence" in prompt
        assert "source fix" in prompt
        assert "objective lease only before mutation" in prompt
        assert "reader-privacy boundaries" in prompt
        assert "one replace-in-place Latest run" in prompt


def test_checkout_lease_is_atomic_and_release_is_fail_closed(tmp_path: Path, monkeypatch):
    lease_path = tmp_path / ".git" / "agent-team-lease.json"
    lease_path.parent.mkdir()
    monkeypatch.setattr(objective_lease, "LEASE_PATH", lease_path)
    checkout = {"dirty": False, "head": "abc123", "remote": "abc123"}

    def fake_git(*args: str) -> str:
        values = {
            ("status", "--porcelain"): " M file" if checkout["dirty"] else "",
            ("rev-parse", "HEAD"): checkout["head"],
            ("rev-parse", "origin/main"): checkout["remote"],
            ("rev-parse", "--abbrev-ref", "HEAD"): "main",
            ("rev-parse", "--abbrev-ref", "@{upstream}"): "origin/main",
        }
        return values[args]

    monkeypatch.setattr(objective_lease, "git", fake_git)
    monkeypatch.setattr(objective_lease, "fetch_origin", lambda: None)
    claimed = objective_lease.claim(
        "run",
        current_time=datetime(2026, 8, 29, 12, 0, tzinfo=timezone.utc),
        holder_id="thread-1",
        hostname="test-host",
        starting_head="abc123",
        lease_id="lease-1",
    )
    assert claimed["lease_id"] == "lease-1"
    assert "holder_pid" not in claimed
    assert lease_path.stat().st_mode & 0o777 == 0o600
    with pytest.raises(SystemExit, match="already held"):
        objective_lease.claim("archive")
    checkout["dirty"] = True
    with pytest.raises(SystemExit, match="dirty"):
        objective_lease.release("run", "lease-1")
    checkout["dirty"] = False
    checkout["head"] = "current-run-commit"
    with pytest.raises(SystemExit, match="synchronized"):
        objective_lease.release("run", "lease-1")
    checkout["head"] = "abc123"
    objective_lease.release("run", "lease-1")
    assert not lease_path.exists()


def test_check_base_rejects_upstream_movement(tmp_path: Path, monkeypatch):
    lease_path = tmp_path / ".git" / "agent-team-lease.json"
    lease_path.parent.mkdir()
    monkeypatch.setattr(objective_lease, "LEASE_PATH", lease_path)
    remote = {"head": "abc123"}

    def fake_git(*args: str) -> str:
        values = {
            ("status", "--porcelain"): "",
            ("rev-parse", "HEAD"): "current-run-commit",
            ("rev-parse", "origin/main"): remote["head"],
            ("rev-parse", "--abbrev-ref", "HEAD"): "main",
            ("rev-parse", "--abbrev-ref", "@{upstream}"): "origin/main",
        }
        return values[args]

    monkeypatch.setattr(objective_lease, "git", fake_git)
    monkeypatch.setattr(objective_lease, "fetch_origin", lambda: None)
    monkeypatch.setattr(objective_lease, "is_ancestor", lambda ancestor, descendant: True)
    objective_lease.claim(
        "improve", holder_id="thread-2", starting_head="abc123", lease_id="lease-2"
    )
    objective_lease.check_base("improve", "lease-2")
    remote["head"] = "someone-else-pushed"
    with pytest.raises(SystemExit, match="origin/main moved"):
        objective_lease.check_base("improve", "lease-2")


def test_stale_clear_requires_durable_proof_or_explicit_manual_clear(tmp_path: Path, monkeypatch):
    lease_path = tmp_path / ".git" / "agent-team-lease.json"
    lease_path.parent.mkdir()
    monkeypatch.setattr(objective_lease, "LEASE_PATH", lease_path)
    monkeypatch.setattr(objective_lease.socket, "gethostname", lambda: "test-host")
    monkeypatch.setattr(objective_lease, "git", lambda *args: "" if args[0] == "status" else "abc")
    objective_lease.claim(
        "archive",
        current_time=datetime(2026, 8, 29, 0, 0, tzinfo=timezone.utc),
        holder_id="thread-3",
        hostname="test-host",
        starting_head="abc",
        lease_id="lease-3",
    )
    with pytest.raises(SystemExit, match="no durable holder pid"):
        objective_lease.clear_stale(
            8, current_time=datetime(2026, 8, 29, 12, 0, tzinfo=timezone.utc)
        )
    with pytest.raises(SystemExit, match="--confirm-inactive"):
        objective_lease.clear_manual("thread-3", False)
    with pytest.raises(SystemExit, match="not 'wrong-thread'"):
        objective_lease.clear_manual("wrong-thread", True)
    objective_lease.clear_manual("thread-3", True)
    assert not lease_path.exists()
