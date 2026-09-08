from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
REMOVED_STUDIO_CHECKOUT = "/Users/otto/Projects/studio-thing"


def test_retired_workshop_skills_are_not_shipped() -> None:
    skills_root = ROOT / ".agents" / "skills"

    assert not list(skills_root.glob("workshop-bot-*/SKILL.md"))


def test_active_sources_do_not_reference_removed_studio_checkout() -> None:
    matches = []

    for source_root in (ROOT / ".agents", ROOT / "pipeline"):
        if not source_root.exists():
            continue

        for path in source_root.rglob("*"):
            if not path.is_file():
                continue
            if REMOVED_STUDIO_CHECKOUT in path.read_text(errors="ignore"):
                matches.append(path.relative_to(ROOT).as_posix())

    assert matches == []
