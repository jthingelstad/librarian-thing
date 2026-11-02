"""The keyword index upload ships exactly the file the deploy built and
checked, gzipped, with its fact as metadata, and refuses anything else.
S3 is stubbed."""

import gzip
import importlib.util
import json
import sqlite3
import tempfile
import unittest
from pathlib import Path
from unittest import mock

REPO = Path(__file__).resolve().parents[1]
SCRIPT = REPO / "pipeline" / "deploy" / "upload_keyword_index.py"

spec = importlib.util.spec_from_file_location("pipeline_deploy_upload_keyword_index", SCRIPT)
upload = importlib.util.module_from_spec(spec)
spec.loader.exec_module(upload)

FACT = {
    "built-at": "2026-11-02T21:14:55.946Z",
    "item-count": "38906",
    "index-schema": "1",
    "index-sha256": "da526c72",
}


def _stage(root: Path, fact: dict | None = FACT) -> Path:
    db = sqlite3.connect(root / "keyword_index.db")
    db.execute("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)")
    db.commit()
    db.close()
    if fact is not None:
        (root / "keyword_index.fact.json").write_text(json.dumps(fact), encoding="utf-8")
    return root / "keyword_index.db"


class KeywordIndexUploadTests(unittest.TestCase):
    def test_uploads_the_staged_file_gzipped_with_its_fact(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = _stage(Path(tmp))
            client = mock.Mock()
            with mock.patch.object(upload.boto3, "client", return_value=client):
                fact = upload.upload_index("bucket", "artifacts/keyword_index.db", tmp)
            self.assertEqual(fact, FACT)
            (call,) = client.put_object.call_args_list
            kwargs = call.kwargs
            self.assertEqual(kwargs["Bucket"], "bucket")
            self.assertEqual(kwargs["Key"], "artifacts/keyword_index.db")
            self.assertEqual(kwargs["ContentEncoding"], "gzip")
            self.assertEqual(kwargs["Metadata"], FACT)
            self.assertEqual(gzip.decompress(kwargs["Body"]), path.read_bytes())

    def test_refuses_a_missing_build(self):
        with tempfile.TemporaryDirectory() as tmp:
            client = mock.Mock()
            with mock.patch.object(upload.boto3, "client", return_value=client):
                with self.assertRaises(FileNotFoundError):
                    upload.upload_index("bucket", "artifacts/keyword_index.db", tmp)
            client.put_object.assert_not_called()

    def test_refuses_a_file_without_its_fact_or_not_sqlite(self):
        with tempfile.TemporaryDirectory() as tmp:
            _stage(Path(tmp), fact={"built-at": "2026-11-02T21:14:55Z"})
            client = mock.Mock()
            with mock.patch.object(upload.boto3, "client", return_value=client):
                with self.assertRaisesRegex(ValueError, "item-count, index-schema, index-sha256"):
                    upload.upload_index("bucket", "k", tmp)
                (Path(tmp) / "keyword_index.db").write_bytes(b"not a database")
                with self.assertRaisesRegex(ValueError, "not a SQLite file"):
                    upload.upload_index("bucket", "k", tmp)
            client.put_object.assert_not_called()


if __name__ == "__main__":
    unittest.main()
