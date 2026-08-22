"""Regression coverage for the Workshop Bot launchd installer."""

from __future__ import annotations

import os
import plistlib
import subprocess
import tempfile
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[3]
ADMIN_SCRIPT = REPO_ROOT / "apps/workshop_bot/scripts/admin.sh"
LABEL = "com.weeklything.workshop-bot"


class LaunchdInstallerTests(unittest.TestCase):
    def test_install_writes_start_on_login_plist(self) -> None:
        with tempfile.TemporaryDirectory() as home:
            env = os.environ.copy()
            env["HOME"] = home

            subprocess.run(
                ["bash", str(ADMIN_SCRIPT), "install"],
                cwd=REPO_ROOT,
                env=env,
                check=True,
                capture_output=True,
                text=True,
            )

            plist_path = Path(home) / "Library/LaunchAgents" / f"{LABEL}.plist"
            with plist_path.open("rb") as plist_file:
                config = plistlib.load(plist_file)

        self.assertEqual(config["Label"], LABEL)
        self.assertIs(config["RunAtLoad"], True)
        self.assertIs(config["KeepAlive"], True)
        self.assertEqual(config["WorkingDirectory"], str(REPO_ROOT))
        self.assertEqual(
            config["ProgramArguments"],
            [str(REPO_ROOT / ".venv/bin/python"), "-m", "apps.workshop_bot.bot"],
        )


if __name__ == "__main__":
    unittest.main()
