"""Issue items — the row-backed model for in-flight content.

Replaces the byte-chunk model in :mod:`tools.content.chunks`. Each Notable
link, Brief link, and Journal entry in an issue is a row in the
``issue_items`` table. Reorders become ``UPDATE position``; promotions
become column flips; editorial comments anchor to ``item_id`` via the
``editorial_comments`` table.

The rendering surfaces read from here:

- ``update-draft`` syncs upstream sources (Pinboard / micro.blog) into
  rows, then renders ``draft.md`` from rows + the file-backed atoms
  (intro / outro / cover / currently / haiku).
- ``reorder`` proposes orderings in JSON; the apply step calls
  :func:`reorder`. The LLM never touches bytes; identity comes from row
  id. (Promotions come from the micro.blog ``Featured`` category at sync
  time, not from this pass.)
- ``tools/renderers`` renders ``archive.md`` / ``buttondown.md`` from the
  same rows, splicing promoted items into their declared positions.

Editorial comments are written by Eddy's review pass and read by both
the HTML drawer (handle badges + copy buttons) and the Discord lookup
(``@eddy tell me about E349-N1``). Re-reviews supersede earlier
comments via ``replaced_by_id`` rather than deleting them.
"""

from __future__ import annotations

import json
import logging
from typing import Any, Optional

from .db.connection import connect

logger = logging.getLogger("workshop.issue_items")

# Sections that exist as rows in ``issue_items``. The file-backed atoms
# (intro / outro / cover / currently / haiku) don't appear here.
SECTIONS = ("notable", "brief", "journal")

# Promoted (standalone-featured) sections splice into one of four slots
# at build-publish time. ``before_notable`` is the slot category-driven
# Featured posts use (micro.blog category "Featured"); ``after_*`` slots
# are the legacy Eddy-driven positions kept for schema compatibility.
PROMOTION_POSITIONS = ("before_notable", "after_notable", "after_journal", "after_brief")

# Source identifiers. ``manual`` is reserved for entries Jamie or a job
# inserts directly (e.g. the WT348 migration script).
SOURCES = ("pinboard", "microblog", "manual")

# Handle letters for editorial_comments. Section-anchored comments use
# the section's letter; cross-cutting scopes use X (hygiene) or W
# (whole-issue). Cover is V (visual) — C is taken by Currently.
SECTION_HANDLE_LETTER: dict[str, str] = {
    "notable": "N",
    "brief": "B",
    "journal": "J",
    "currently": "C",
    "cover": "V",
    "intro": "I",
    "outro": "O",
    "haiku": "H",
}
HYGIENE_LETTER = "X"
ISSUE_LETTER = "W"
ALL_HANDLE_LETTERS = (
    *SECTION_HANDLE_LETTER.values(),
    HYGIENE_LETTER,
    ISSUE_LETTER,
)


# ---------- exceptions ----------


class ReorderError(ValueError):
    """Raised when a reorder request can't be applied (not a permutation).

    The message is operator-readable; surfaces to ``#editorial`` so
    Jamie can react 🔄 and try again.
    """


# ---------- row → dict ----------


def _row_to_dict(row) -> dict[str, Any]:
    d = dict(row)
    if "body_override" in d:
        source_body = d.get("body_md")
        override = d.get("body_override")
        d["source_body_md"] = source_body
        d["body_overridden"] = override is not None
        if override is not None:
            d["body_md"] = override
    raw = d.get("metadata_json")
    if raw:
        try:
            d["metadata"] = json.loads(raw)
        except TypeError, ValueError:
            d["metadata"] = None
    else:
        d["metadata"] = None
    return d


# ---------- CRUD ----------


def upsert_item(
    *,
    issue_number: int,
    section: str,
    source: str,
    source_id: str,
    url: Optional[str] = None,
    title: Optional[str] = None,
    body_md: Optional[str] = None,
    metadata: Optional[dict[str, Any]] = None,
) -> int:
    """Insert a new row or update the existing one keyed on
    ``(issue_number, source, source_id)``.

    A new row gets ``position = MAX(position) + 1`` within its section
    (appended). An existing row preserves its position, ``is_promoted``,
    ``promoted_position``, and ``promoted_heading`` — those are editorial
    state (``position`` from ``reorder``; the promotion fields from the
    ``Featured``-category promotion path), not re-derived from the
    upstream item on every sync. Editor-owned columns such as
    ``section_override``, ``excluded``, and ``body_override`` are not written
    here, so web edits survive daily source refreshes.
    Only the upstream-derivable fields (url, title, body_md, metadata,
    section) get refreshed; section is allowed to change in case Jamie
    re-tags a Pinboard item ``_brief`` mid-cycle.

    **URL-based dedup fallback.** When ``(issue, source, source_id)``
    doesn't match but a row in this issue already has the same ``url``
    (i.e. it was seeded under a different source identity — e.g. a manual
    seed using ``source='manual'`` later refreshed by ``sync_pinboard``
    with ``source='pinboard'`` and the bookmark's hash), treat it as
    the same item: re-key it to the canonical ``(source, source_id)``
    and update in place. Without this we'd insert a duplicate every
    time ``update-draft`` ran, which is the WT348-doubling regression
    the exercise harness caught.

    Returns the row id.
    """
    if section not in SECTIONS:
        raise ValueError(f"unknown section: {section!r}")
    if source not in SOURCES:
        raise ValueError(f"unknown source: {source!r}")
    meta_json = json.dumps(metadata, sort_keys=True) if metadata else None
    with connect() as conn:
        row = conn.execute(
            "SELECT id, section, position FROM issue_items "
            "WHERE issue_number = ? AND source = ? AND source_id = ?",
            (issue_number, source, source_id),
        ).fetchone()
        if row is None and url:
            # URL-based fallback (see docstring). Match on the issue's
            # other rows by URL; if found, re-key the row's source identity
            # so subsequent syncs hit the canonical key directly. Older
            # ``id`` wins on ties (deterministic / matches insertion order).
            alt = conn.execute(
                "SELECT id, section, position FROM issue_items "
                "WHERE issue_number = ? AND url = ? "
                "ORDER BY id ASC LIMIT 1",
                (issue_number, url),
            ).fetchone()
            if alt is not None:
                conn.execute(
                    "UPDATE issue_items SET source = ?, source_id = ?, "
                    "updated_at = datetime('now') WHERE id = ?",
                    (source, source_id, alt["id"]),
                )
                row = alt
        if row is not None:
            # Re-tagging upstream can move an item between sections (e.g.
            # Jamie adds ``_brief`` to a Pinboard bookmark mid-cycle).
            # Preserve position when section is unchanged; otherwise
            # assign a fresh position at the end of the new section so
            # we don't smuggle a stale ordinal into a different list.
            new_position = int(row["position"])
            if section != str(row["section"]):
                new_position = conn.execute(
                    "SELECT COALESCE(MAX(position), 0) + 1 AS next_pos "
                    "FROM issue_items "
                    "WHERE issue_number = ? AND section = ?",
                    (issue_number, section),
                ).fetchone()["next_pos"]
            conn.execute(
                "UPDATE issue_items SET "
                "  section = ?, position = ?, url = ?, title = ?, body_md = ?, "
                "  metadata_json = ?, updated_at = datetime('now') "
                "WHERE id = ?",
                (section, int(new_position), url, title, body_md, meta_json, row["id"]),
            )
            return int(row["id"])
        # New row — append to section.
        next_pos = conn.execute(
            "SELECT COALESCE(MAX(position), 0) + 1 AS next_pos "
            "FROM issue_items "
            "WHERE issue_number = ? AND section = ?",
            (issue_number, section),
        ).fetchone()["next_pos"]
        cur = conn.execute(
            "INSERT INTO issue_items "
            "(issue_number, section, position, source, source_id, "
            " url, title, body_md, metadata_json) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (
                issue_number,
                section,
                int(next_pos),
                source,
                source_id,
                url,
                title,
                body_md,
                meta_json,
            ),
        )
        return int(cur.lastrowid or 0)


def get_item(item_id: int) -> Optional[dict[str, Any]]:
    """Fetch one row by id. Returns ``None`` if absent."""
    with connect() as conn:
        row = conn.execute(
            "SELECT * FROM issue_items WHERE id = ?",
            (item_id,),
        ).fetchone()
    return _row_to_dict(row) if row is not None else None


def list_items(
    issue_number: int,
    *,
    section: Optional[str] = None,
    include_promoted: bool = True,
    include_excluded: bool = False,
) -> list[dict[str, Any]]:
    """List items for an issue, optionally filtered to one section.

    Returns rows ordered by (section, position). ``include_promoted=False``
    drops items lifted to a featured section — useful when rendering the
    parent section's body (a promoted item shouldn't also appear in its
    parent).

    **Editor-aware:** the ``section`` filter matches
    the *effective* section — ``COALESCE(section_override, section)`` — so a
    briefly ↔ notable flip made in the web editor flows through every
    consumer (draft, renderers, reorder, status) uniformly. Rows deselected
    in the editor (``excluded = 1``) are dropped unless
    ``include_excluded=True`` (the editor itself lists them so they can be
    re-selected). ``body_override`` is exposed as the effective ``body_md``;
    callers that need the upstream source text can read ``source_body_md``.
    With no overrides/exclusions set, results are identical to the
    pre-editor behavior.
    """
    sql = "SELECT * FROM issue_items WHERE issue_number = ?"
    args: list[Any] = [issue_number]
    if section is not None:
        if section not in SECTIONS:
            raise ValueError(f"unknown section: {section!r}")
        sql += " AND COALESCE(section_override, section) = ?"
        args.append(section)
    if not include_promoted:
        sql += " AND is_promoted = 0"
    if not include_excluded:
        sql += " AND excluded = 0"
    sql += " ORDER BY COALESCE(section_override, section), position"
    with connect() as conn:
        rows = conn.execute(sql, args).fetchall()
    return [_row_to_dict(r) for r in rows]


def promoted_items(issue_number: int) -> list[dict[str, Any]]:
    """Items lifted into a standalone featured section, ordered by
    declaration. Each row carries ``promoted_position`` and
    ``promoted_heading``. Editor-deselected rows don't render."""
    with connect() as conn:
        rows = conn.execute(
            "SELECT * FROM issue_items "
            "WHERE issue_number = ? AND is_promoted = 1 AND excluded = 0 "
            "ORDER BY id",
            (issue_number,),
        ).fetchall()
    return [_row_to_dict(r) for r in rows]


# ---------- mutations ----------


def reorder(issue_number: int, section: str, ordered_ids: list[int]) -> None:
    """Rewrite ``position`` for every non-promoted item in
    (issue, section) to match ``ordered_ids``.

    Raises :class:`ReorderError` if ``ordered_ids`` is not a strict
    permutation of the current non-promoted ids in the section (missing,
    extra, or duplicate ids each get a precise message).

    Applied in a single transaction. To avoid stomping on the UNIQUE
    (issue, source, source_id) constraint we don't need a temp column —
    ``position`` isn't unique-indexed. We just write in order.
    """
    if section not in SECTIONS:
        raise ValueError(f"unknown section: {section!r}")
    if len(set(ordered_ids)) != len(ordered_ids):
        dupes = sorted({x for x in ordered_ids if ordered_ids.count(x) > 1})
        raise ReorderError(
            f"{section}: duplicate id(s) in order: {', '.join(str(d) for d in dupes)}"
        )
    with connect() as conn:
        # Effective section + not excluded — must mirror list_items so the
        # permutation check validates against exactly what the proposal saw.
        rows = conn.execute(
            "SELECT id FROM issue_items "
            "WHERE issue_number = ? AND COALESCE(section_override, section) = ? "
            "  AND is_promoted = 0 AND excluded = 0",
            (issue_number, section),
        ).fetchall()
        have = {int(r["id"]) for r in rows}
        want = set(int(i) for i in ordered_ids)
        extra = sorted(want - have)
        missing = sorted(have - want)
        if extra:
            raise ReorderError(
                f"{section}: order names id(s) that don't exist in this section: "
                f"{', '.join(str(x) for x in extra)}"
            )
        if missing:
            raise ReorderError(
                f"{section}: order is missing id(s): {', '.join(str(x) for x in missing)}"
            )
        # Apply in one transaction. Use position values starting at
        # (max_existing + 1) to dodge any intermediate collisions, then
        # compact in a second pass. No unique index on position so this
        # isn't strictly necessary, but it's cheap insurance.
        for i, item_id in enumerate(ordered_ids, start=1):
            conn.execute(
                "UPDATE issue_items SET position = ?, updated_at = datetime('now') WHERE id = ?",
                (i, int(item_id)),
            )


def promote(
    item_id: int,
    *,
    promoted_position: str,
    promoted_heading: str,
) -> None:
    """Lift an item out of its parent section into a standalone
    featured section. Idempotent — re-calling with the same args is a
    no-op; calling with different args updates the promotion.

    ``promoted_position`` must be one of :data:`PROMOTION_POSITIONS`;
    ``promoted_heading`` is the H2 text that will render in the
    published issue.
    """
    if promoted_position not in PROMOTION_POSITIONS:
        raise ValueError(
            f"promoted_position must be one of {PROMOTION_POSITIONS}, got {promoted_position!r}"
        )
    heading = (promoted_heading or "").strip()
    if not heading:
        raise ValueError("promoted_heading must be a non-empty string")
    with connect() as conn:
        conn.execute(
            "UPDATE issue_items SET "
            "  is_promoted = 1, promoted_position = ?, promoted_heading = ?, "
            "  updated_at = datetime('now') "
            "WHERE id = ?",
            (promoted_position, heading, int(item_id)),
        )


def set_section_override(item_id: int, override: Optional[str]) -> None:
    """Editor-owned briefly ↔ notable flip (atom editor, build 1).

    ``override`` is a section name or ``None`` to clear (revert to the
    sync-owned section). Setting an override assigns a fresh position at the
    end of the *target* effective section — same rule ``upsert_item`` uses on
    an upstream re-tag — so the flipped item lands at the end of its new list
    instead of smuggling a stale ordinal in. ``issue_items_sync`` never
    writes this column, so the flip survives the daily upstream refresh.
    """
    if override is not None and override not in SECTIONS:
        raise ValueError(f"unknown section: {override!r}")
    with connect() as conn:
        row = conn.execute(
            "SELECT issue_number, section, section_override FROM issue_items WHERE id = ?",
            (int(item_id),),
        ).fetchone()
        if row is None:
            raise ValueError(f"item_id={item_id!r} not found")
        target = override or str(row["section"])
        current = str(row["section_override"] or row["section"])
        if target == current:  # no-op flip (e.g. clearing an unset override)
            if override == row["section_override"]:
                return
        next_pos = conn.execute(
            "SELECT COALESCE(MAX(position), 0) + 1 AS next_pos FROM issue_items "
            "WHERE issue_number = ? AND COALESCE(section_override, section) = ?",
            (int(row["issue_number"]), target),
        ).fetchone()["next_pos"]
        conn.execute(
            "UPDATE issue_items SET section_override = ?, position = ?, "
            "  updated_at = datetime('now') WHERE id = ?",
            (override, int(next_pos), int(item_id)),
        )


def set_excluded(item_id: int, excluded: bool) -> None:
    """Editor-owned select/deselect (atom editor, build 1). A deselected row
    stays in the table (reversible; survives sync — the pruner only removes
    rows whose *upstream* item disappeared) but no longer renders anywhere."""
    with connect() as conn:
        cur = conn.execute(
            "UPDATE issue_items SET excluded = ?, updated_at = datetime('now') WHERE id = ?",
            (1 if excluded else 0, int(item_id)),
        )
        if not cur.rowcount:
            raise ValueError(f"item_id={item_id!r} not found")


def set_body_override(item_id: int, body_md: Optional[str]) -> None:
    """Editor-owned body replacement for an ``issue_items`` row.

    ``None`` clears the override and reverts render output to the
    source-owned ``body_md``. An empty string is a real override: it removes
    the item's commentary/body from the issue while leaving title and URL
    source-owned.
    """
    with connect() as conn:
        cur = conn.execute(
            "UPDATE issue_items SET body_override = ?, updated_at = datetime('now') WHERE id = ?",
            (body_md, int(item_id)),
        )
        if not cur.rowcount:
            raise ValueError(f"item_id={item_id!r} not found")


def move_item(item_id: int, direction: str) -> bool:
    """Editor-owned up/down reorder within the item's *effective* section
    (atom editor, build 1). Swaps positions with the adjacent non-promoted,
    non-excluded neighbour. Returns False when already at the edge."""
    if direction not in ("up", "down"):
        raise ValueError(f"direction must be 'up' or 'down', got {direction!r}")
    with connect() as conn:
        row = conn.execute(
            "SELECT id, issue_number, COALESCE(section_override, section) AS eff "
            "FROM issue_items WHERE id = ?",
            (int(item_id),),
        ).fetchone()
        if row is None:
            raise ValueError(f"item_id={item_id!r} not found")
        rows = conn.execute(
            "SELECT id FROM issue_items "
            "WHERE issue_number = ? AND COALESCE(section_override, section) = ? "
            "  AND is_promoted = 0 AND excluded = 0 "
            "ORDER BY position, id",
            (int(row["issue_number"]), str(row["eff"])),
        ).fetchall()
        ids = [int(r["id"]) for r in rows]
        if int(item_id) not in ids:
            return False  # promoted/excluded rows don't take part
        i = ids.index(int(item_id))
        j = i - 1 if direction == "up" else i + 1
        if j < 0 or j >= len(ids):
            return False
        ids[i], ids[j] = ids[j], ids[i]
        for pos, iid in enumerate(ids, start=1):
            conn.execute(
                "UPDATE issue_items SET position = ?, updated_at = datetime('now') WHERE id = ?",
                (pos, iid),
            )
    return True


def unpromote(item_id: int) -> None:
    """Drop a promotion (return the item to its parent section)."""
    with connect() as conn:
        conn.execute(
            "UPDATE issue_items SET "
            "  is_promoted = 0, promoted_position = NULL, promoted_heading = NULL, "
            "  updated_at = datetime('now') "
            "WHERE id = ?",
            (int(item_id),),
        )


def clear_promotions(issue_number: int) -> None:
    """Drop every promotion for an issue. Used by ``reset-final`` to wipe
    the editorial pass clean so a fresh reorder + Featured-category sync
    re-establishes promotions (old ones shouldn't linger)."""
    with connect() as conn:
        conn.execute(
            "UPDATE issue_items SET "
            "  is_promoted = 0, promoted_position = NULL, promoted_heading = NULL, "
            "  updated_at = datetime('now') "
            "WHERE issue_number = ? AND is_promoted = 1",
            (int(issue_number),),
        )


def clear_issue(issue_number: int) -> None:
    """Delete every item row for an issue. Used by the WT348 migration
    test fixture and by reset flows in the Studio web app;
    not part of the normal cycle.
    """
    with connect() as conn:
        conn.execute(
            "DELETE FROM issue_items WHERE issue_number = ?",
            (int(issue_number),),
        )


def compact_positions(issue_number: int, section: str) -> None:
    """Renumber positions 1..N within (issue, section), preserving
    current order. Useful after deletes leave gaps."""
    if section not in SECTIONS:
        raise ValueError(f"unknown section: {section!r}")
    with connect() as conn:
        rows = conn.execute(
            "SELECT id FROM issue_items "
            "WHERE issue_number = ? AND section = ? "
            "ORDER BY position, id",
            (issue_number, section),
        ).fetchall()
        for i, r in enumerate(rows, start=1):
            conn.execute(
                "UPDATE issue_items SET position = ? WHERE id = ?",
                (i, int(r["id"])),
            )


# ---------- editorial comments ----------


def _next_handle_ordinal(issue_number: int, letter: str) -> int:
    """Highest ordinal in use for (issue, letter), plus one. Handles are
    never reused — superseded comments still occupy their slot, so
    Jamie's "tell me about E349-N3" works days later even if N3 was
    replaced by N7 in a later pass."""
    if letter not in ALL_HANDLE_LETTERS:
        raise ValueError(f"unknown handle letter: {letter!r}")
    prefix = f"E{int(issue_number)}-{letter}"
    with connect() as conn:
        rows = conn.execute(
            "SELECT handle FROM editorial_comments WHERE issue_number = ? AND handle LIKE ?",
            (issue_number, f"{prefix}%"),
        ).fetchall()
    max_ord = 0
    for r in rows:
        tail = str(r["handle"])[len(prefix) :]
        try:
            n = int(tail)
        except ValueError:
            continue
        if n > max_ord:
            max_ord = n
    return max_ord + 1


def _letter_for(scope: str, section: Optional[str]) -> str:
    """Pick the handle letter for a comment from its scope + section."""
    if scope == "hygiene":
        return HYGIENE_LETTER
    if scope == "issue":
        return ISSUE_LETTER
    if scope in ("item", "section"):
        if section is None or section not in SECTION_HANDLE_LETTER:
            raise ValueError(
                f"scope={scope!r} requires section ∈ "
                f"{tuple(SECTION_HANDLE_LETTER)}; got {section!r}"
            )
        return SECTION_HANDLE_LETTER[section]
    raise ValueError(f"unknown scope: {scope!r}")


def write_comment(
    *,
    issue_number: int,
    scope: str,
    body_md: str,
    item_id: Optional[int] = None,
    section: Optional[str] = None,
    verdict: str = "suggestion",
    anchor_text: Optional[str] = None,
    reasoning_md: Optional[str] = None,
    handle: Optional[str] = None,
) -> dict[str, Any]:
    """Insert one editorial comment and return ``{id, handle, ...}``.

    Generates a stable handle (``E349-N1``, ``E349-X3``, …) keyed on
    issue + scope/section. Caller can pass ``handle`` explicitly when
    backfilling history; otherwise one is assigned.

    ``scope='item'`` requires ``item_id``; the row's ``section`` is
    populated from the item so the handle's letter is consistent
    regardless of where the LLM placed the comment.
    """
    if scope not in ("item", "section", "issue", "hygiene"):
        raise ValueError(f"unknown scope: {scope!r}")
    if verdict not in ("positive", "suggestion", "blocker"):
        raise ValueError(f"unknown verdict: {verdict!r}")
    if not body_md or not body_md.strip():
        raise ValueError("body_md must be a non-empty string")
    if scope == "item" and item_id is None:
        raise ValueError("scope='item' requires item_id")
    if scope == "item" and item_id is not None:
        # Derive (and overwrite) section from the item so the handle is
        # tied to where the item lives, not where the LLM said.
        item = get_item(int(item_id))
        if item is None:
            raise ValueError(f"item_id={item_id!r} not found")
        section = str(item["section"])
    if handle is None:
        letter = _letter_for(scope, section)
        ordinal = _next_handle_ordinal(issue_number, letter)
        handle = f"E{int(issue_number)}-{letter}{ordinal}"
    with connect() as conn:
        cur = conn.execute(
            "INSERT INTO editorial_comments "
            "(handle, issue_number, scope, item_id, section, verdict, "
            " anchor_text, body_md, reasoning_md) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (
                handle,
                int(issue_number),
                scope,
                int(item_id) if item_id is not None else None,
                section,
                verdict,
                anchor_text,
                body_md,
                reasoning_md,
            ),
        )
        return {
            "id": int(cur.lastrowid or 0),
            "handle": handle,
            "issue_number": int(issue_number),
            "scope": scope,
            "item_id": int(item_id) if item_id is not None else None,
            "section": section,
            "verdict": verdict,
            "anchor_text": anchor_text,
            "body_md": body_md,
            "reasoning_md": reasoning_md,
        }


def get_comment_by_handle(handle: str) -> Optional[dict[str, Any]]:
    """Fetch a comment by its stable handle. Used by the Discord
    ``@eddy tell me about E349-N1`` lookup (built next phase)."""
    with connect() as conn:
        row = conn.execute(
            "SELECT * FROM editorial_comments WHERE handle = ?",
            (handle,),
        ).fetchone()
    return dict(row) if row is not None else None


def list_open_comments(issue_number: int) -> list[dict[str, Any]]:
    """Comments for an issue that are still considered open — neither
    superseded by a follow-on comment nor closed by a PASS review pass.
    Ordered by creation, newest first."""
    with connect() as conn:
        rows = conn.execute(
            "SELECT * FROM editorial_comments "
            "WHERE issue_number = ? "
            "  AND replaced_by_id IS NULL "
            "  AND closed_at IS NULL "
            "ORDER BY created_at DESC, id DESC",
            (int(issue_number),),
        ).fetchall()
    return [dict(r) for r in rows]


def close_all_open_comments(issue_number: int) -> int:
    """Mark every still-open comment for ``issue_number`` as closed —
    ``closed_at`` gets a UTC ISO timestamp. Used when a fresh review
    pass returned PASS (no new comments to chain via ``replaced_by_id``,
    but the prior pass's guidance is stale). Returns the row count."""
    with connect() as conn:
        cur = conn.execute(
            "UPDATE editorial_comments SET closed_at = datetime('now') "
            "WHERE issue_number = ? "
            "  AND replaced_by_id IS NULL "
            "  AND closed_at IS NULL",
            (int(issue_number),),
        )
        return int(cur.rowcount or 0)


def close_comment(comment_id: int, issue_number: int) -> bool:
    """Resolve one still-open comment, scoped to its issue."""
    with connect() as conn:
        cur = conn.execute(
            "UPDATE editorial_comments SET closed_at = datetime('now') "
            "WHERE id = ? AND issue_number = ? "
            "  AND replaced_by_id IS NULL AND closed_at IS NULL",
            (int(comment_id), int(issue_number)),
        )
        return bool(cur.rowcount)


def supersede(comment_id: int, by_id: int) -> None:
    """Mark ``comment_id`` as superseded by ``by_id``. The replacement
    stays in the history; the previous handle keeps pointing at its
    own row."""
    with connect() as conn:
        conn.execute(
            "UPDATE editorial_comments SET replaced_by_id = ? WHERE id = ?",
            (int(by_id), int(comment_id)),
        )


def supersede_all_open(issue_number: int, by_id: int) -> int:
    """Bulk-supersede every open comment for an issue. Used at the
    start of a new review pass so the new pass replaces the old one
    wholesale. ``by_id`` is the first comment in the new pass —
    individual comments in the new pass can later carry their own
    finer-grained ``replaced_by`` if needed."""
    with connect() as conn:
        cur = conn.execute(
            "UPDATE editorial_comments SET replaced_by_id = ? "
            "WHERE issue_number = ? AND replaced_by_id IS NULL AND id != ?",
            (int(by_id), int(issue_number), int(by_id)),
        )
        return int(cur.rowcount or 0)
