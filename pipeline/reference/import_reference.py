"""Pull the reference documents into the Librarian's data tree.

Documents about Jamie (a bio, a resume) are written in git under
``reference-documents/``, one Markdown file each with front matter (its
README is the guide). This importer checks every one the way the corpus
build reads it (``librarian_core.reference``) and mirrors the folder into
``data/reference/``, which the library absorbs as the ``reference`` origin
and the reference corpus build reads. A malformed document fails the import
naming its file, and nothing is written; a document deleted from git is
deleted here, and so from the library.

Unpublished documents (``data/reference-unpublished/``, placed in the
library by hand, never in git) are not this importer's: it never writes to
or removes anything in that folder. Given it (``--unpublished-dir``), it
only refuses a document named like one there, since a name is one id.

The library round runs it against main's copy (``library.py pull``, source
``reference``), never against whatever branch a checkout has.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

from librarian_core.paths import REFERENCE_DIR, REFERENCE_INTAKE_DIR
from librarian_core.reference import (
    ReferenceDocumentError,
    document_paths,
    name_clashes,
    read_document,
)


def mirror(
    source_dir: Path, output_dir: Path, unpublished_dir: Path | None = None
) -> dict[str, list[str]]:
    """Make ``output_dir`` hold exactly the documents in ``source_dir``,
    byte for byte. Every document is checked before anything is written, and
    so is every name against ``unpublished_dir``, which is only read.
    Returns the names added, changed and removed."""
    documents = document_paths(source_dir)
    for path in documents:
        read_document(path)
    if unpublished_dir is not None and (clashes := name_clashes(source_dir, unpublished_dir)):
        raise ReferenceDocumentError(
            f"reference document {clashes[0]}: is in both reference/ and "
            "reference-unpublished/; a name is one document, so rename or remove one of them"
        )
    wanted = {path.name: path.read_bytes() for path in documents}
    changes: dict[str, list[str]] = {"added": [], "changed": [], "removed": []}
    if output_dir.is_dir():
        for existing in sorted(output_dir.iterdir()):
            if existing.is_file() and existing.name not in wanted:
                existing.unlink()
                changes["removed"].append(existing.name)
    output_dir.mkdir(parents=True, exist_ok=True)
    for name, content in wanted.items():
        target = output_dir / name
        if target.is_file():
            if target.read_bytes() == content:
                continue
            changes["changed"].append(name)
        else:
            changes["added"].append(name)
        target.write_bytes(content)
    return changes


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument(
        "--source-dir",
        type=Path,
        default=REFERENCE_INTAKE_DIR,
        help="the reference-documents folder to read",
    )
    parser.add_argument(
        "--output-dir", type=Path, default=REFERENCE_DIR, help="where the data tree keeps them"
    )
    parser.add_argument(
        "--unpublished-dir",
        type=Path,
        help="the tree's reference-unpublished folder, read only to refuse a name in both",
    )
    args = parser.parse_args(argv)
    try:
        changes = mirror(args.source_dir, args.output_dir, args.unpublished_dir)
    except ReferenceDocumentError as error:
        print(f"reference import failed: {error}", file=sys.stderr)
        return 1
    held = len(document_paths(args.output_dir))
    moved = ", ".join(f"{len(names)} {what}" for what, names in changes.items() if names)
    print(f"reference: {held} documents from {args.source_dir}" + (f" ({moved})" if moved else ""))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
