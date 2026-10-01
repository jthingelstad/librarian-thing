"""The archive checks in the corpus gate, the daily audio freshness pull, and
the 2026-10-01 Journal permalink repair they protect.

Plan docs/PLAN-2026-10-01-qa-followups.md, plans 2 and 5.
"""

from __future__ import annotations

import csv
import importlib.util
import json
import tempfile
import unittest
import unittest.mock
from pathlib import Path

import yaml
from librarian_core.paths import REPO

AUDIO_URL = "https://files.thingelstad.com/weekly-thing/274/weekly-thing-274-aa.mp3"


def _load(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


gate = _load("test_corpus_gate_module", REPO / "pipeline" / "corpus" / "corpus_gate.py")
repair = _load(
    "test_repair_journal_permalinks", REPO / "pipeline" / "audits" / "repair_journal_permalinks.py"
)


def _page(directory: Path, number: int, audio: bool) -> None:
    lines = ["---", f"number: {number}", "layout: archive"]
    if audio:
        lines += [
            f"audio_url: {AUDIO_URL}",
            "audio_duration_seconds: 2537",
            "audio_chapters:",
            "  - start: 0",
            "    title: Featured",
            "  - start: 1697",
            "    title: Journal",
        ]
    directory.joinpath(f"{number}.md").write_text("\n".join(lines + ["---", "Body."]) + "\n")


def _corpus(audio: dict | None, unmatched: int = 33) -> dict:
    issue = {"number": 274}
    if audio is not None:
        issue["audio"] = audio
    return {"issues": [issue, {"number": 275}], "journal_copy_stats": {"unmatched": unmatched}}


RECORD = {
    "url": AUDIO_URL,
    "duration_seconds": 2537,
    "chapters": [{"start": 0, "title": "Featured"}, {"start": 1697, "title": "Journal"}],
}


class AudioDriftTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.site = Path(self.tmp.name)
        _page(self.site, 274, audio=True)
        _page(self.site, 275, audio=False)

    def tearDown(self):
        self.tmp.cleanup()

    def test_matching_record_is_fresh(self):
        self.assertEqual(gate.audio_drift(_corpus(RECORD), gate.site_audio(self.site)), [])

    def test_missing_record_is_drift(self):
        drift = gate.audio_drift(_corpus(None), gate.site_audio(self.site))
        self.assertEqual(len(drift), 1)
        self.assertIn("WT274", drift[0])

    def test_regenerated_chapters_are_drift(self):
        stale = {**RECORD, "chapters": RECORD["chapters"][:1]}
        self.assertEqual(len(gate.audio_drift(_corpus(stale), gate.site_audio(self.site))), 1)

    def test_page_without_audio_is_not_checked(self):
        site = gate.site_audio(self.site)
        self.assertNotIn(275, site)

    def test_gate_passes_clean_candidate(self):
        self.assertEqual(gate.gate_failures(_corpus(RECORD), self.site), [])

    def test_gate_fails_when_unmatched_rises(self):
        failures = gate.gate_failures(_corpus(RECORD, unmatched=34), self.site)
        self.assertEqual(len(failures), 1)
        self.assertIn("unmatched rose to 34", failures[0])

    def test_gate_fails_without_the_site_checkout(self):
        failures = gate.gate_failures(_corpus(RECORD), self.site / "missing")
        self.assertTrue(any("site archive unavailable" in f for f in failures))

    def test_gate_command_reads_the_staged_candidate(self):
        stage = self.site / "stage"
        stage.mkdir()
        (stage / "corpus.json").write_text(json.dumps(_corpus(None)))
        self.assertEqual(
            gate.main(["gate", "--candidate", str(stage), "--site-archive", str(self.site)]), 1
        )
        (stage / "corpus.json").write_text(json.dumps(_corpus(RECORD)))
        self.assertEqual(
            gate.main(["gate", "--candidate", str(stage), "--site-archive", str(self.site)]), 0
        )

    def test_freshness_sets_stale_output(self):
        corpus = self.site / "corpus.json"
        output = self.site / "github_output"
        corpus.write_text(json.dumps(_corpus(None)))
        argv = ["freshness", "--site-archive", str(self.site), "--corpus", str(corpus)]
        with unittest.mock.patch.dict("os.environ", {"GITHUB_OUTPUT": str(output)}):
            self.assertEqual(gate.main(argv), 0)
            corpus.write_text(json.dumps(_corpus(RECORD)))
            self.assertEqual(gate.main(argv), 0)
        self.assertEqual(output.read_text().splitlines(), ["stale=true", "stale=false"])


class WorkflowTest(unittest.TestCase):
    def setUp(self):
        self.workflow = yaml.safe_load((REPO / ".github" / "workflows" / "deploy.yml").read_text())
        self.steps = self.workflow["jobs"]["produce"]["steps"]
        self.names = [step.get("name", "") for step in self.steps]

    def test_freshness_runs_sunday_to_thursday(self):
        # PyYAML reads the bare `on:` key as True.
        crons = [entry["cron"] for entry in self.workflow[True]["schedule"]]
        self.assertEqual(crons, ["30 12 * * 0-4"])

    def test_freshness_decides_before_detect_changes(self):
        fresh = self.names.index("Audio freshness (site audio editions vs the live corpus)")
        self.assertLess(fresh, self.names.index("Detect changes"))

    def test_archive_gate_runs_before_the_upload(self):
        archive = self.names.index("Corpus gate (archive checks on the staged candidates)")
        upload = self.names.index("Upload Weekly Thing corpus + graph to S3")
        self.assertLess(archive, upload)
        self.assertIn("corpus_gate.py gate", self.steps[archive]["run"])
        self.assertIn("blog_corpus == 'true'", self.steps[archive]["if"])


class BlogDateGateTest(unittest.TestCase):
    """QA2 I2-8, T2-2 and Q16: a blog post is filed by the Chicago day of
    ``published``, and a 05:00Z date-only placeholder reads as Chicago noon."""

    def post(self, **fields):
        return {
            "microblog_id": 1,
            "published": "2019-11-22T18:00:00+00:00",
            "publish_date": "2019-11-22",
            "post_year": 2019,
            "permalink_date": "2020-04-21",
            **fields,
        }

    def test_chicago_day_passes(self):
        self.assertEqual(gate.blog_date_failures({"posts": [self.post()]}), [])

    def test_permalink_day_fails(self):
        failures = gate.blog_date_failures(
            {"posts": [self.post(publish_date="2020-04-21", post_year=2020)]}
        )
        self.assertEqual(len(failures), 1)
        self.assertIn("is 2019-11-22 in Chicago", failures[0])

    def test_kept_placeholder_fails(self):
        # 23:00 the evening before in Chicago, filed on that day: the date
        # agrees, but the placeholder should have become noon on the 22nd.
        kept = self.post(
            published="2019-11-22T05:00:00+00:00", publish_date="2019-11-21", post_year=2019
        )
        failures = gate.blog_date_failures({"posts": [kept]})
        self.assertEqual(len(failures), 1)
        self.assertIn("placeholder", failures[0])

    def test_a_real_late_post_is_not_a_placeholder(self):
        # 4482285: 23:00 Chicago on Nov 22 2024, and its permalink says the 22nd.
        late = self.post(
            published="2024-11-23T05:00:00+00:00",
            publish_date="2024-11-22",
            post_year=2024,
            permalink_date=None,
        )
        self.assertEqual(gate.blog_date_failures({"posts": [late]}), [])

    def test_gate_command_reads_a_staged_blog_candidate(self):
        with tempfile.TemporaryDirectory() as tmp:
            stage = Path(tmp)
            blog = {"posts": [self.post(publish_date="2020-04-21", post_year=2020)]}
            (stage / "blog_corpus.json").write_text(json.dumps(blog))
            argv = ["gate", "--candidate", str(stage), "--site-archive", str(stage / "none")]
            self.assertEqual(gate.main(argv), 1)
            (stage / "blog_corpus.json").write_text(json.dumps({"posts": [self.post()]}))
            self.assertEqual(gate.main(argv), 0)


class JournalRepairTest(unittest.TestCase):
    OLD = "https://www.thingelstad.com/2019/05/25/ground-crew-out.html"
    NEW = "https://www.thingelstad.com/2019/05/25/minnesota-united-v.html"

    def test_repair_changes_only_link_targets(self):
        page = (
            "---\n"
            f"audio_url: {AUDIO_URL}\n"
            f"note: ]({self.OLD})\n"
            "---\n"
            f"### [Saturday @ 8:01 PM]({self.OLD})\n"
            f"Plain mention of {self.OLD} stays.\n"
        )
        fixed, changed = repair.repair(page, {self.OLD: self.NEW})
        self.assertEqual(changed, 1)
        self.assertIn(f"### [Saturday @ 8:01 PM]({self.NEW})", fixed)
        self.assertIn(f"note: ]({self.OLD})", fixed)  # front matter untouched
        self.assertIn(f"Plain mention of {self.OLD} stays.", fixed)
        self.assertEqual(repair.repair(fixed, {self.OLD: self.NEW}), (fixed, 0))

    def test_builder_issues_are_refused(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "map.csv"
            with path.open("w", newline="") as handle:
                writer = csv.DictWriter(
                    handle, fieldnames=["issue", "old_url", "repair_to", "verdict"]
                )
                writer.writeheader()
                writer.writerow(
                    {
                        "issue": 350,
                        "old_url": self.OLD,
                        "repair_to": self.NEW,
                        "verdict": "confirmed",
                    }
                )
            with self.assertRaises(SystemExit):
                repair.confirmed_rows(path)

    def test_the_reviewed_map_is_applied_to_the_canonical_archive(self):
        rows = repair.confirmed_rows(repair.MAP)
        self.assertEqual(sum(len(pairs) for pairs in rows.values()), 432)
        for issue, pairs in rows.items():
            body = (REPO / "data" / "issues" / str(issue) / "archive.md").read_text()
            for old, new in pairs.items():
                self.assertNotIn(f"]({old})", body, f"WT{issue}")
                self.assertIn(f"]({new})", body, f"WT{issue}")


if __name__ == "__main__":
    unittest.main()
