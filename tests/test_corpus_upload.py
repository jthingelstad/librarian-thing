"""The Weekly Thing corpus upload ships vision descriptions on its media.

Review defect 3 (docs/REVIEW-2026-09-29-mcp-corpus.md): CI's WT upload never
merged data/librarian/media-descriptions.json, so production WT photos had no
`description` while blog photos did. These tests drive the uploader without
AWS: S3 and Bedrock are stubbed, the built corpus is read back from
--keep-output.
"""

import importlib.util
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

REPO = Path(__file__).resolve().parents[1]
SCRIPT = REPO / "pipeline" / "deploy" / "upload_corpus.py"

spec = importlib.util.spec_from_file_location("pipeline_deploy_upload_corpus", SCRIPT)
upload = importlib.util.module_from_spec(spec)
spec.loader.exec_module(upload)

DESCRIBED = "https://files.thingelstad.com/weekly-thing/351/images/aaa.jpg"
UNDESCRIBED = "https://files.thingelstad.com/weekly-thing/351/images/bbb.jpg"
FAILED = "https://assets.buttondown.email/images/ccc.jpg"


def _fixture(root: Path) -> tuple[Path, Path, Path]:
    archive = root / "archive"
    (archive / "351").mkdir(parents=True)
    (archive / "351" / "archive.md").write_text(
        "---\nnumber: 351\nsubject: Weekly Thing 351\n"
        "publish_date: '2026-09-26T12:00:00Z'\n---\n"
        "Intro.\n\n"
        "## Photos\n\n"
        f'<img src="{DESCRIBED}" alt="">\n\n'
        "Tidepools at low tide.\n\n"
        f"![]({UNDESCRIBED})\n\n"
        f'<img alt="authored alt" src="{FAILED}">\n',
        encoding="utf-8",
    )
    sidecar = root / "media-descriptions.json"
    sidecar.write_text(
        json.dumps(
            {
                DESCRIBED: {"description": "Rocky tidepools with sea stars at low tide."},
                FAILED: {"error": "api_400"},
            }
        ),
        encoding="utf-8",
    )
    site = root / "site"
    (site / "_data").mkdir(parents=True)
    return archive, sidecar, site


class WeeklyThingUploadMediaDescriptionTests(unittest.TestCase):
    def test_build_merges_sidecar_descriptions_into_media(self):
        with tempfile.TemporaryDirectory() as tmp:
            archive, sidecar, site = _fixture(Path(tmp))
            corpus = upload.build_wt_corpus(
                archive, sidecar, site_dir=site, faq_path=Path(tmp) / "missing.json"
            )

        media = {entry["url"]: entry for entry in corpus["media"]}
        self.assertEqual(
            media[DESCRIBED]["description"], "Rocky tidepools with sea stars at low tide."
        )
        self.assertNotIn("description", media[UNDESCRIBED])
        self.assertNotIn("description", media[FAILED])
        # Authored text stays beside the description, untouched.
        self.assertEqual(media[FAILED]["alt"], "authored alt")
        self.assertEqual(media[DESCRIBED]["context"], "Tidepools at low tide.")
        # Still the production shape: issue bodies included.
        self.assertIn("body", corpus["issues"][0])

    def test_main_uploads_the_annotated_corpus(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            archive, sidecar, _site = _fixture(root)
            out = root / "out" / "corpus.json"
            uploaded: list[str] = []
            argv = [
                "upload_corpus.py",
                "--bucket",
                "b",
                "--key",
                "artifacts/corpus.json",
                "--skip-graph",
            ]
            with (
                mock.patch.object(upload, "ARCHIVE_DIR", archive),
                mock.patch.object(upload, "MEDIA_DESCRIPTIONS_PATH", sidecar),
                mock.patch.object(upload, "load_dotenv"),
                mock.patch.object(upload, "fetch_existing_corpus", return_value=None),
                mock.patch.object(upload, "add_bedrock_embeddings"),
                mock.patch.object(
                    upload, "upload_json_gzip", side_effect=lambda b, k, p: uploaded.append(k)
                ),
                mock.patch.object(sys, "argv", argv + ["--keep-output", str(out)]),
            ):
                self.assertEqual(upload.main(), 0)
            shipped = json.loads(out.read_text(encoding="utf-8"))

        self.assertEqual(uploaded, ["artifacts/corpus.json"])
        described = [m for m in shipped["media"] if m.get("description")]
        self.assertEqual([m["url"] for m in described], [DESCRIBED])

    def test_stage_writes_candidates_and_uploads_nothing(self):
        # The corpus gate: deploy.yml evals what --stage wrote before any
        # upload, then --upload-staged ships those exact files.
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            archive, sidecar, _site = _fixture(root)
            stage = root / "stage"
            uploaded: list[tuple[str, str]] = []
            base = ["upload_corpus.py", "--bucket", "b", "--key", "artifacts/corpus.json"]
            patches = (
                mock.patch.object(upload, "ARCHIVE_DIR", archive),
                mock.patch.object(upload, "MEDIA_DESCRIPTIONS_PATH", sidecar),
                mock.patch.object(upload, "load_dotenv"),
                mock.patch.object(upload, "fetch_existing_corpus", return_value=None),
                mock.patch.object(upload, "add_bedrock_embeddings"),
                mock.patch.object(upload, "build_graph", return_value={"nodes": []}),
                mock.patch.object(
                    upload,
                    "upload_json_gzip",
                    side_effect=lambda b, k, p: uploaded.append((k, Path(p).name)),
                ),
            )
            for patch in patches:
                patch.start()
            self.addCleanup(mock.patch.stopall)
            with mock.patch.object(sys, "argv", base + ["--stage", str(stage)]):
                self.assertEqual(upload.main(), 0)
            self.assertEqual(uploaded, [])
            staged = json.loads((stage / "corpus.json").read_text(encoding="utf-8"))
            self.assertEqual(staged["issues"][0]["number"], 351)
            self.assertEqual(json.loads((stage / "graph.json").read_text()), {"nodes": []})

            with mock.patch.object(sys, "argv", base + ["--upload-staged", str(stage)]):
                self.assertEqual(upload.main(), 0)
            self.assertEqual(
                uploaded,
                [("artifacts/corpus.json", "corpus.json"), ("artifacts/graph.json", "graph.json")],
            )

    def test_upload_staged_refuses_a_missing_stage(self):
        with tempfile.TemporaryDirectory() as tmp:
            argv = ["upload_corpus.py", "--bucket", "b", "--upload-staged", tmp]
            with (
                mock.patch.object(upload, "load_dotenv"),
                mock.patch.object(upload, "upload_json_gzip") as put,
                mock.patch.object(sys, "argv", argv),
                self.assertRaises(FileNotFoundError),
            ):
                upload.main()
            put.assert_not_called()


if __name__ == "__main__":
    unittest.main()
