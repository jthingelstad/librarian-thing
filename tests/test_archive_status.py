import importlib.util
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
STATUS_PATH = REPO / "pipeline" / "status.py"
spec = importlib.util.spec_from_file_location("archive_status", STATUS_PATH)
status = importlib.util.module_from_spec(spec)
spec.loader.exec_module(status)


class ArchiveStatusTests(unittest.TestCase):
    def test_reports_canonical_store_and_extraction_evidence(self):
        original_deployed_artifacts = status.deployed_artifacts
        status.deployed_artifacts = lambda: {
            "corpus": {"unavailable": True},
            "graph": {"unavailable": True},
        }
        try:
            report = status.build_report()
        finally:
            status.deployed_artifacts = original_deployed_artifacts

        summary = report["summary"]
        corpus = report["local_artifacts"]["corpus"]
        self.assertGreater(summary["total_issues"], 0)
        self.assertEqual(summary["archive_missing"], 0)
        self.assertTrue(summary["local_corpus_matches_archive"])
        self.assertGreater(corpus["media_count"], 0)
        self.assertGreater(corpus["currently_count"], 0)
        self.assertGreater(corpus["journal_post_url_count"], 0)


if __name__ == "__main__":
    unittest.main()
