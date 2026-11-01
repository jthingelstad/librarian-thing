"""The meaning eval's vector reuse: only the same model, only the same input."""

import importlib.util
import json
from pathlib import Path

import numpy as np
import pytest

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location(
    "embed_variant", ROOT / "pipeline/eval/embed_variant.py"
)
embed_variant = importlib.util.module_from_spec(spec)
spec.loader.exec_module(embed_variant)


@pytest.fixture
def plain_inputs(monkeypatch):
    monkeypatch.setattr(embed_variant, "embed_input", lambda chunk, link_text: chunk["text"])


def write_run(folder: Path, model: str, chunks: list[dict], hashes: bool = True) -> None:
    folder.mkdir()
    (folder / "meta.json").write_text(json.dumps({"model": model, "dimensions": 4}))
    (folder / "blog.ids.json").write_text(json.dumps([chunk["id"] for chunk in chunks]))
    np.zeros((len(chunks), 4), dtype=np.float32).tofile(folder / "blog.f32")
    if hashes:
        digests = [embed_variant.input_hash(chunk["text"]) for chunk in chunks]
        (folder / "blog.sha256.json").write_text(json.dumps(digests))


def test_reuse_refuses_another_model(tmp_path, plain_inputs):
    write_run(tmp_path / "run", "cohere.embed-english-v3", [{"id": "a", "text": "x"}])
    with pytest.raises(SystemExit, match="embed-english-v3"):
        embed_variant.Reuse(tmp_path / "run", "blog", 4, "us.cohere.embed-v4:0")


def test_a_profile_and_its_base_model_are_the_same_model():
    assert embed_variant.same_model("us.cohere.embed-v4:0", "cohere.embed-v4:0")
    assert not embed_variant.same_model("cohere.embed-english-v3", "cohere.embed-v4:0")


def test_reuse_needs_the_inputs_recorded_with_the_vectors(tmp_path, plain_inputs):
    write_run(tmp_path / "run", "us.cohere.embed-v4:0", [{"id": "a", "text": "x"}], hashes=False)
    with pytest.raises(SystemExit, match="sha256"):
        embed_variant.Reuse(tmp_path / "run", "blog", 4, "cohere.embed-v4:0")


def test_reuse_only_serves_an_unchanged_input(tmp_path, plain_inputs):
    write_run(
        tmp_path / "run",
        "us.cohere.embed-v4:0",
        [{"id": "a", "text": "old"}, {"id": "b", "text": "same"}],
    )
    reuse = embed_variant.Reuse(tmp_path / "run", "blog", 4, "us.cohere.embed-v4:0")
    assert reuse.find({"id": "a", "text": "new"}, "cut") is None
    assert reuse.find({"id": "b", "text": "same"}, "cut") == 1
    assert reuse.find({"id": "c", "text": "same"}, "cut") is None


def test_a_run_resumes_only_its_own_model_and_dimensions(tmp_path, plain_inputs):
    write_run(tmp_path / "run", "cohere.embed-english-v3", [{"id": "a", "text": "x"}])
    with pytest.raises(SystemExit, match="embed-english-v3"):
        embed_variant.open_output(tmp_path / "run", "us.cohere.embed-v4:0", 4)
    with pytest.raises(SystemExit, match="dimensions"):
        embed_variant.open_output(tmp_path / "run", "cohere.embed-english-v3", 1024)
    assert embed_variant.open_output(tmp_path / "run", "cohere.embed-english-v3", 4)["model"]


def test_vectors_with_no_named_model_are_not_resumed(tmp_path, plain_inputs):
    write_run(tmp_path / "run", "cohere.embed-english-v3", [{"id": "a", "text": "x"}])
    (tmp_path / "run" / "meta.json").unlink()
    with pytest.raises(SystemExit, match="no meta.json"):
        embed_variant.open_output(tmp_path / "run", "cohere.embed-english-v3", 4)


def test_a_run_names_its_model_before_its_first_vector(tmp_path, monkeypatch):
    def stopped(*args):
        raise KeyboardInterrupt

    monkeypatch.setattr(embed_variant, "Embedder", stopped)
    with pytest.raises(KeyboardInterrupt):
        embed_variant.main(["--out", str(tmp_path / "run"), "--model", "us.cohere.embed-v4:0"])
    meta = json.loads((tmp_path / "run" / "meta.json").read_text())
    assert meta["model"] == "us.cohere.embed-v4:0"
    assert meta["dimensions"] == 1536
