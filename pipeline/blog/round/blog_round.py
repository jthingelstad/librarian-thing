#!/usr/bin/env python3
"""The blog round: the Librarian files new blog posts, drafts alt for empty
ones, and notes the day's Featured candidates
(docs/PLAN-2026-10-22-blog-steward.md, "The daily round", steps 5 to 7).

    python pipeline/blog/round/blog_round.py                  # propose and report
    python pipeline/blog/round/blog_round.py --recheck 10     # re-file the 10 newest, compare
    python pipeline/blog/round/blog_round.py --posts blog-1,blog-2
    python pipeline/blog/round/blog_round.py --write tmp/blog-round/<day>.json   # plan step 5

Without ``--write`` nothing reaches micro.blog: the round reads each post
live, proposes, and writes ``tmp/blog-round/<day>.json`` (the proposals, for
the Library Agent to review and edit) and ``<day>.md`` (the report). Into the
library it records only what the Librarian made: labels for new posts, an
event for every write it would make (``dry_run`` 1), and the images it found
gone (``alt_skips``). It downloads the library first and uploads it with the
ETag it started from, once more from a fresh copy if the library moved.

``--write`` applies a reviewed proposals file and refuses until plan step 5
turns writes on (``guards.WRITES_ON``). ``--recheck`` and ``--posts`` re-file
posts already filed to show how the labeller reads them; they are never
written. Every guard is in ``guards.py``; a ``PAUSED`` file beside it stops
the round.
"""

from __future__ import annotations

import argparse
import json
import os
import sqlite3
import sys
import uuid
from collections import Counter
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Any

from dotenv import load_dotenv
from librarian_core.library.db import now
from librarian_core.paths import REPO

HERE = Path(__file__).resolve().parent
sys.path[:0] = [str(HERE), str(HERE.parent), str(HERE.parents[1] / "library")]

import alt_text  # noqa: E402
import anthropic_client  # noqa: E402
import filing  # noqa: E402
import guards  # noqa: E402
import library  # noqa: E402
from micropub import Micropub, MicropubError  # noqa: E402

OUT_DIR = REPO / "tmp" / "blog-round"
BLOG_KINDS = ("post", "micropost")
# Labels that keep a post off Featured whatever its numbers (plan, "Featured").
NOT_FEATURED = frozenset({"link", "photo", "quote", "checkin", "automated"})
FEATURED_AFTER_DAYS = 7


@dataclass
class Made:
    """What the round adds to the library, kept apart so a conflict can
    re-apply it to a fresh copy."""

    labels: list[dict[str, Any]] = field(default_factory=list)
    events: list[dict[str, Any]] = field(default_factory=list)
    skips: list[dict[str, Any]] = field(default_factory=list)
    filings: list[dict[str, Any]] = field(default_factory=list)
    categories: list[dict[str, Any]] = field(default_factory=list)

    def empty(self) -> bool:
        return not (self.labels or self.events or self.skips or self.filings or self.categories)


def apply(conn: sqlite3.Connection, made: Made) -> None:
    for row in made.labels:
        conn.execute(
            "INSERT OR REPLACE INTO labels (source_id, topics, subjects, gist, kind, place, "
            "substance, evergreen, model, labeled_at) VALUES (:source_id, :topics, :subjects, "
            ":gist, :kind, :place, :substance, :evergreen, :model, :labeled_at)",
            row,
        )
    for row in made.categories:
        conn.execute(
            "INSERT OR IGNORE INTO categories (name, slug, kind, description, why, made_by, "
            "created_at) VALUES (:name, :slug, :kind, :description, '', 'librarian', :at)",
            row,
        )
    for row in made.filings:
        conn.execute(
            "INSERT INTO filings (source_id, categories, alt_filled, jamie_set, filed_by, "
            "filed_at) VALUES (:source_id, :categories, :alt_filled, :jamie_set, :filed_by, "
            ":filed_at) ON CONFLICT (source_id) DO UPDATE SET categories = excluded.categories, "
            "alt_filled = excluded.alt_filled, jamie_set = excluded.jamie_set, "
            "filed_by = excluded.filed_by, filed_at = excluded.filed_at",
            row,
        )
    for row in made.skips:
        conn.execute(
            "INSERT OR IGNORE INTO alt_skips (url, reason, noted_at) VALUES (:url, :reason, :at)",
            row,
        )
    for row in made.events:
        conn.execute(
            "INSERT INTO events (at, run, action, target, before, after, dry_run, result) "
            "VALUES (:at, :run, :action, :target, :before, :after, :dry_run, :result)",
            row,
        )


def central_day(stamp: str) -> str:
    return datetime.fromisoformat(stamp).astimezone(library.CENTRAL).date().isoformat()


def uid(source_id: str) -> str:
    return source_id.removeprefix("blog-")


class Round:
    def __init__(
        self,
        conn: sqlite3.Connection,
        *,
        micropub: Any,
        labeller: Callable[[filing.Catalog, str], filing.Filing],
        alt_writer: Callable[[str, str], str],
        today: date,
    ):
        self.conn = conn
        self.micropub = micropub
        self.labeller = labeller
        self.alt_writer = alt_writer
        self.today = today
        self.run = f"blog-{today.isoformat()}-{uuid.uuid4().hex[:6]}"
        self.made = Made()
        self.catalog = filing.load_catalog(conn)
        self.cost = Counter()
        self.notes: list[str] = []

    # What to read.

    def _post(self, source_id: str) -> sqlite3.Row | None:
        return self.conn.execute(
            "SELECT s.id, s.url, s.title, s.published, s.categories, f.categories AS filed, "
            "f.jamie_set, f.alt_filled, f.filed_by FROM sources s "
            "LEFT JOIN filings f ON f.source_id = s.id "
            "WHERE s.id = ? AND s.kind IN ('post', 'micropost')",
            (source_id,),
        ).fetchone()

    def unfiled(self, limit: int) -> list[str]:
        rows = self.conn.execute(
            "SELECT s.id FROM sources s LEFT JOIN filings f ON f.source_id = s.id "
            "WHERE s.kind IN ('post', 'micropost') AND f.source_id IS NULL "
            "ORDER BY s.published DESC"
        )
        return [row["id"] for row in rows if row["id"] not in guards.SHARED_ADDRESS][:limit]

    def newest_filed(self, limit: int) -> list[str]:
        rows = self.conn.execute(
            "SELECT s.id FROM sources s JOIN filings f ON f.source_id = s.id "
            "WHERE s.kind IN ('post', 'micropost') AND f.jamie_set = 0 "
            "ORDER BY s.published DESC"
        )
        return [row["id"] for row in rows if row["id"] not in guards.SHARED_ADDRESS][:limit]

    def drift(self) -> list[dict[str, Any]]:
        """Filed posts whose categories on micro.blog (as last pulled) are not
        what the Librarian last wrote: someone else changed them."""
        out = []
        for row in self.conn.execute(
            "SELECT s.id, s.url, s.categories, f.categories AS filed, f.jamie_set "
            "FROM sources s JOIN filings f ON f.source_id = s.id "
            "WHERE s.kind IN ('post', 'micropost')"
        ):
            live, filed = json.loads(row["categories"]), json.loads(row["filed"])
            if row["id"] in guards.SHARED_ADDRESS or guards.same_set(live, filed):
                continue
            out.append(
                {
                    "source_id": row["id"],
                    "url": row["url"],
                    "live": live,
                    "filed": filed,
                    "jamie_set": bool(row["jamie_set"]),
                }
            )
        return out

    # Categories.

    def propose_categories(self, source_ids: list[str], *, check: bool) -> list[dict[str, Any]]:
        out = []
        for source_id in source_ids:
            post = self._post(source_id)
            if post is None:
                self.notes.append(f"{source_id} is not a blog post in the library")
                continue
            live = self.micropub.source(post["url"], uid(source_id))
            if live is None:
                out.append(self._proposal(post, None, check, "micro.blog did not answer for it"))
                continue
            result = self.labeller(self.catalog, source_id)
            self._spend(result.model, result.usage)
            if result.stop:
                out.append(
                    self._proposal(post, None, check, f"the labeller stopped ({result.stop})")
                )
                continue
            if result.missing and guards.twin_of(result.missing, self.catalog.name_list()):
                result.missing = ""  # a category the catalog already has
            if not check:
                self.made.labels.append(self._label(result))
            target = guards.target_categories(live["categories"], result.picks, self.catalog.kinds)
            proposal = self._proposal(
                post, result, check, guards.check_target(live["categories"], target)
            )
            proposal.update(live=live["categories"], target=target)
            if result.new_trip:
                proposal["new_trip_problem"] = guards.check_new_name(
                    result.new_trip, self.catalog.name_list()
                )
            if (
                not check
                and not proposal["problem"]
                and not guards.same_set(proposal["live"], target)
            ):
                self._event("categories", source_id, proposal["live"], target)
            out.append(proposal)
        return out

    def _proposal(
        self, post: sqlite3.Row, result: filing.Filing | None, check: bool, problem: str | None
    ) -> dict[str, Any]:
        return {
            "source_id": post["id"],
            "url": post["url"],
            "title": post["title"],
            "published": post["published"],
            "check": check,
            "filed": json.loads(post["filed"]) if post["filed"] else None,
            "live": json.loads(post["categories"]),
            "target": [],
            "picks": result.picks if result else [],
            "new_trip": result.new_trip if result else "",
            "missing": result.missing if result else "",
            "gist": result.labels.get("gist", "") if result else "",
            "reason": result.reason if result else "",
            "model": result.model if result else None,
            "problem": problem,
        }

    def _label(self, result: filing.Filing) -> dict[str, Any]:
        labels = result.labels
        return {
            "source_id": result.source_id,
            "topics": json.dumps(labels["topics"]),
            "subjects": json.dumps(labels["subjects"]),
            "gist": labels["gist"],
            "kind": labels["kind"],
            "place": labels["place"] or None,
            "substance": str(labels["substance"]),
            "evergreen": 1 if labels["evergreen"] else 0,
            "model": result.model,
            "labeled_at": now(),
        }

    def new_categories(self, proposals: list[dict[str, Any]]) -> list[dict[str, Any]]:
        """The trips the labeller would make, with their posts, for the agent
        to accept (and describe) or not. Never accepted here."""
        trips: dict[str, dict[str, Any]] = {}
        for proposal in proposals:
            name = proposal.get("new_trip")
            if not name or proposal["check"]:
                continue
            entry = trips.setdefault(
                guards.slug(name),
                {
                    "name": name,
                    "kind": "trip",
                    "description": "",
                    "accept": False,
                    "problem": proposal.get("new_trip_problem"),
                    "source_ids": [],
                },
            )
            entry["source_ids"].append(proposal["source_id"])
        return list(trips.values())

    # Alt.

    def alt_candidates(self) -> list[sqlite3.Row]:
        rows = self.conn.execute(
            "SELECT m.source_id, m.url AS src, s.url, s.published, "
            "(SELECT count(*) FROM media o WHERE o.source_id = m.source_id AND o.url = m.url) AS seen "
            "FROM media m JOIN sources s ON s.id = m.source_id "
            "LEFT JOIN alt_skips k ON k.url = m.url "
            "WHERE s.kind IN ('post', 'micropost') AND (m.alt IS NULL OR trim(m.alt) = '') "
            "AND k.url IS NULL ORDER BY s.published DESC, m.position"
        ).fetchall()
        return [row for row in rows if row["source_id"] not in guards.SHARED_ADDRESS]

    def propose_alt(self, limit: int) -> list[dict[str, Any]]:
        out = []
        drafted = 0
        for row in self.alt_candidates():
            if drafted >= limit:
                break
            proposal = {
                "source_id": row["source_id"],
                "url": row["url"],
                "src": row["src"],
                "alt": "",
                "context": "",
                "problem": None,
            }
            out.append(proposal)
            if row["seen"] > 1:
                proposal["problem"] = "the image is in the post more than once"
                continue
            live = self.micropub.source(row["url"], uid(row["source_id"]))
            if live is None or live["content"] is None:
                proposal["problem"] = (
                    "micro.blog did not answer for it"
                    if live is None
                    else "micro.blog gives its body as HTML, not its source"
                )
                continue
            edited, why = guards.splice_alt(live["content"], row["src"], "x")
            if edited is None:
                proposal["problem"] = why
                continue
            alt, how = self._draft(row["source_id"], row["src"], live["content"])
            drafted += how == "drafted"
            if not alt:
                proposal["problem"] = how
                continue
            edited, why = guards.splice_alt(live["content"], row["src"], alt)
            proposal.update(alt=alt, context=how, problem=None if edited else why)
            if edited:
                self._event(
                    "alt", row["src"], {"source_id": row["source_id"], "alt": ""}, {"alt": alt}
                )
        return out

    def _draft(self, source_id: str, src: str, content: str) -> tuple[str, str]:
        """An alt for ``src`` and how it came: drafted now, or the draft an
        earlier dry run made for it (a dry run never pays twice)."""
        row = self.conn.execute(
            "SELECT after FROM events WHERE action = 'alt' AND target = ? AND result = 'proposed' "
            "ORDER BY id DESC LIMIT 1",
            (src,),
        ).fetchone()
        if row:
            return json.loads(row["after"])["alt"], "drafted by an earlier dry run"
        described = self.conn.execute(
            "SELECT description FROM descriptions WHERE url = ?", (src,)
        ).fetchone()
        context = filing.readable(self.conn, content)
        if described and described["description"]:
            context = (
                f"The archive describes this image as: {described['description']}\n\n{context}"
            )
        alt = self.alt_writer(src, context)
        if not alt and alt_text.known_dead(src):
            self.made.skips.append(
                {
                    "url": src,
                    "reason": f"gone (404/410), found by the blog round on {self.today}",
                    "at": now(),
                }
            )
            return "", "the image is gone from micro.blog (now in alt_skips)"
        return alt, "drafted" if alt else "the vision call gave nothing"

    # Featured.

    def featured_candidates(self) -> list[dict[str, Any]]:
        """Titled posts that went up a week ago (US Central), with the
        evidence the agent weighs. Notes only; Featured waits for Jamie's
        first list."""
        day = (self.today - timedelta(days=FEATURED_AFTER_DAYS)).isoformat()
        since = (self.today - timedelta(days=FEATURED_AFTER_DAYS + 2)).isoformat()
        out = []
        for row in self.conn.execute(
            "SELECT s.id, s.url, s.title, s.published, s.categories, l.kind, l.substance, "
            "l.evergreen, l.gist FROM sources s LEFT JOIN labels l ON l.source_id = s.id "
            "WHERE s.kind = 'post' AND coalesce(s.title, '') != '' AND s.published >= ?",
            (since,),
        ):
            if central_day(row["published"]) != day or row["kind"] in NOT_FEATURED:
                continue
            if row["id"] in guards.SHARED_ADDRESS:
                continue
            views = self.conn.execute(
                "SELECT coalesce(sum(d.views), 0) AS n FROM reader_paths p JOIN reader_days d "
                "ON d.site = p.site AND d.path = p.path WHERE p.source_id = ? AND p.measure = 'views'",
                (row["id"],),
            ).fetchone()["n"]
            kudos = self.conn.execute(
                "SELECT count(*) AS n FROM kudos k JOIN reader_paths p ON p.site = k.site "
                "AND p.path = k.path WHERE p.source_id = ?",
                (row["id"],),
            ).fetchone()["n"]
            out.append(
                {
                    "source_id": row["id"],
                    "url": row["url"],
                    "title": row["title"],
                    "gist": row["gist"],
                    "substance": row["substance"],
                    "evergreen": bool(row["evergreen"]),
                    "views": views,
                    "kudos": kudos,
                    "featured": guards.FEATURED in guards.slugs(json.loads(row["categories"])),
                }
            )
        return out

    # Writes (plan step 5).

    def done_today(self) -> Counter:
        """Writes made today (US Central) by any round, for the pace caps."""
        done: Counter = Counter()
        for row in self.conn.execute(
            "SELECT action, at FROM events WHERE dry_run = 0 AND result = 'ok' AND at >= ?",
            ((self.today - timedelta(days=1)).isoformat(),),
        ):
            if central_day(row["at"]) == self.today.isoformat():
                done[row["action"]] += 1
        return done

    def write(self, proposals: dict[str, Any]) -> dict[str, list[str]]:
        guards.check_running(writing=True)
        done = self.done_today()
        said: dict[str, list[str]] = {"written": [], "left": [], "needs_jamie": []}
        accepted: dict[str, dict[str, Any]] = {}
        for entry in proposals.get("new_categories", []):
            if not entry.get("accept"):
                continue
            problem = guards.check_new_name(entry["name"], self.catalog.name_list())
            if entry.get("kind") not in ("trip", "series", "project", "topic", "kept"):
                problem = f"no kind {entry.get('kind')!r} in the catalog"
            elif not (entry.get("description") or "").strip():
                problem = problem or "every category needs its description first"
            if problem:
                said["left"].append(f"new category {entry['name']}: {problem}")
                continue
            accepted[guards.slug(entry["name"])] = entry
        for proposal in proposals.get("categories", []):
            if proposal["check"] or proposal["problem"] or not proposal["picks"]:
                continue
            if done["categories"] >= guards.CATEGORY_CAP:
                said["needs_jamie"].append(f"past {guards.CATEGORY_CAP} category writes today")
                break
            done["categories"] += self._write_categories(proposal, accepted, said)
        for proposal in proposals.get("alt", []):
            if proposal["problem"] or not proposal["alt"]:
                continue
            if done["alt"] >= guards.ALT_CAP:
                said["needs_jamie"].append(f"past {guards.ALT_CAP} alt edits today")
                break
            done["alt"] += self._write_alt(proposal, said)
        return said

    def _write_categories(
        self,
        proposal: dict[str, Any],
        accepted: dict[str, dict[str, Any]],
        said: dict[str, list[str]],
    ) -> int:
        source_id = proposal["source_id"]
        post = self._post(source_id)
        live = self.micropub.source(proposal["url"], uid(source_id))
        if post is None or live is None:
            said["left"].append(f"{source_id}: micro.blog did not answer for it")
            return 0
        expected = json.loads(post["filed"]) if post["filed"] else proposal["live"]
        if not guards.same_set(live["categories"], expected):
            self._adopt(source_id, live["categories"], post)
            said["left"].append(f"{source_id}: someone else changed its categories; adopted them")
            return 0
        unknown = [
            name for name in proposal["picks"] if guards.slug(name) not in self.catalog.names
        ]
        if unknown:
            said["left"].append(f"{source_id}: not in the catalog: {', '.join(unknown)}")
            return 0
        picks = list(proposal["picks"])
        new = accepted.get(guards.slug(proposal.get("new_trip") or ""))
        kinds = dict(self.catalog.kinds)
        if new:
            picks.insert(0, new["name"])
            kinds[guards.slug(new["name"])] = new["kind"]
        target = guards.target_categories(live["categories"], picks, kinds)
        problem = guards.check_target(live["categories"], target)
        if problem or guards.same_set(live["categories"], target):
            said["left"].append(f"{source_id}: {problem or 'nothing to add'}")
            return 0
        self.micropub.replace_categories(proposal["url"], target)
        back = self.micropub.source(proposal["url"], uid(source_id))
        ok = back is not None and guards.same_set(back["categories"], target)
        if new and ok and guards.slug(new["name"]) not in self.catalog.names:
            self.made.categories.append(
                {
                    "name": new["name"],
                    "slug": guards.slug(new["name"]),
                    "kind": new["kind"],
                    "description": new.get("description") or None,
                    "at": now(),
                }
            )
            self.catalog.names[guards.slug(new["name"])] = new["name"]
        self._filing(source_id, post, categories=back["categories"] if back else target)
        self._event("categories", source_id, live["categories"], target, dry=False, ok=ok)
        said["written" if ok else "left"].append(
            f"{source_id}: {', '.join(target)}" if ok else f"{source_id}: the read-back differs"
        )
        return 1

    def _write_alt(self, proposal: dict[str, Any], said: dict[str, list[str]]) -> int:
        source_id, src = proposal["source_id"], proposal["src"]
        post = self._post(source_id)
        if post is None or post["filed"] is None:
            said["left"].append(f"{source_id}: not filed yet, so its alt waits (file it first)")
            return 0
        live = self.micropub.source(proposal["url"], uid(source_id))
        if live is None or live["content"] is None:
            said["left"].append(f"{source_id}: micro.blog gave no source body")
            return 0
        edited, why = guards.splice_alt(live["content"], src, proposal["alt"])
        if edited is None:
            said["left"].append(f"{source_id} {src}: {why}")
            return 0
        self.micropub.replace_content(proposal["url"], edited)
        back = self.micropub.source(proposal["url"], uid(source_id))
        ok = back is not None and back["content"] == edited
        if ok:
            self._filing(source_id, post, add_alt=src)
        self._event(
            "alt",
            src,
            {"source_id": source_id, "alt": ""},
            {"alt": proposal["alt"]},
            dry=False,
            ok=ok,
        )
        said["written" if ok else "left"].append(
            f"{source_id} {src}: alt filled" if ok else f"{source_id} {src}: the read-back differs"
        )
        return 1

    def _adopt(self, source_id: str, live: list[str], post: sqlite3.Row) -> None:
        self._filing(source_id, post, categories=live, jamie_set=True)
        self._event("adopt", source_id, json.loads(post["filed"] or "[]"), live, dry=False, ok=True)

    def _filing(
        self,
        source_id: str,
        post: sqlite3.Row,
        *,
        categories: list[str] | None = None,
        add_alt: str | None = None,
        jamie_set: bool | None = None,
    ) -> None:
        """Record a post's filing over what this round or the library already
        holds for it; what is not given keeps its value."""
        held = next((row for row in self.made.filings if row["source_id"] == source_id), None)
        if held is None:
            held = {
                "source_id": source_id,
                "categories": post["filed"] or "[]",
                "alt_filled": post["alt_filled"] or "[]",
                "jamie_set": int(bool(post["jamie_set"])),
                "filed_by": post["filed_by"] or "librarian",
            }
            self.made.filings.append(held)
        if categories is not None:
            held["categories"] = json.dumps(categories, ensure_ascii=False)
            held["filed_by"] = "librarian"
        if add_alt is not None:
            held["alt_filled"] = json.dumps([*json.loads(held["alt_filled"]), add_alt])
        if jamie_set:
            held["jamie_set"], held["filed_by"] = 1, "jamie"
        held["filed_at"] = now()

    # Book-keeping.

    def _event(
        self,
        action: str,
        target: str,
        before: Any,
        after: Any,
        *,
        dry: bool = True,
        ok: bool = True,
    ) -> None:
        self.made.events.append(
            {
                "at": now(),
                "run": self.run,
                "action": action,
                "target": target,
                "before": json.dumps(before, ensure_ascii=False),
                "after": json.dumps(after, ensure_ascii=False),
                "dry_run": 1 if dry else 0,
                "result": "proposed" if dry else ("ok" if ok else "mismatch"),
            }
        )

    def _spend(self, model: str, usage: dict[str, int]) -> None:
        self.cost[model] += anthropic_client.cost_usd(model, **usage)


def report(day: str, result: dict[str, Any]) -> str:
    """The round's report, in the order the agent reads it."""
    lines = [f"# Blog round {day}", ""]
    categories = [p for p in result["categories"] if not p["check"]]
    checks = [p for p in result["categories"] if p["check"]]
    would = [p for p in categories if not p["problem"] and not _same(p)]
    lines.append(f"Run {result['run']}, dry run: nothing was written to micro.blog.")
    lines += ["", f"## Categories for new posts ({len(would)} would be written)", ""]
    if not categories:
        lines.append("No unfiled posts.")
    for p in categories:
        lines.append(_category_line(p))
    if checks:
        agree = sum(1 for p in checks if p["filed"] and _filed_same(p))
        lines += ["", f"## Re-filed to check ({agree} of {len(checks)} match the filing)", ""]
        for p in checks:
            lines.append(_category_line(p))
    if result["new_categories"]:
        lines += ["", "## New categories the labeller would make", ""]
        for entry in result["new_categories"]:
            note = f" (refused: {entry['problem']})" if entry["problem"] else ""
            lines.append(
                f"- {entry['name']} ({entry['kind']}): {', '.join(entry['source_ids'])}{note}"
            )
    missing = [p for p in result["categories"] if p["missing"]]
    if missing:
        lines += ["", "## Categories the archive may lack", ""]
        lines += [f"- {p['missing']}: {p['source_id']} ({p['gist']})" for p in missing]
    lines += [
        "",
        f"## Alt ({sum(1 for a in result['alt'] if a['alt'] and not a['problem'])} drafted)",
        "",
    ]
    if not result["alt"]:
        lines.append("No empty alt on any blog post the round may fill.")
    for a in result["alt"]:
        said = f'"{a["alt"]}"' if a["alt"] and not a["problem"] else f"left: {a['problem']}"
        lines.append(f"- {a['source_id']} {a['src']}: {said}")
    lines += ["", f"## Someone else changed ({len(result['drift'])})", ""]
    for d in result["drift"]:
        lines.append(f"- {d['source_id']}: filed {d['filed']}, live {d['live']}")
    if not result["drift"]:
        lines.append("Every filed post still carries what the Librarian last wrote.")
    lines += ["", f"## Featured candidates ({len(result['featured'])})", ""]
    for f in result["featured"]:
        lines.append(
            f"- {f['title']} ({f['source_id']}): substance {f['substance']}, "
            f"{'evergreen' if f['evergreen'] else 'of its moment'}, {f['views']} views, "
            f"{f['kudos']} kudos{', already Featured' if f['featured'] else ''}. {f['gist'] or ''}"
        )
    if not result["featured"]:
        lines.append("No titled post went up a week ago.")
    lines += ["", "## Cost", ""]
    for model, usd in sorted(result["cost"].items()):
        lines.append(f"- {model}: ${usd:.4f}")
    if result["notes"]:
        lines += ["", "## Notes", ""] + [f"- {note}" for note in result["notes"]]
    return "\n".join(lines) + "\n"


def _same(p: dict[str, Any]) -> bool:
    return guards.same_set(p["live"], p["target"]) if p["target"] else True


def _filed_same(p: dict[str, Any]) -> bool:
    picked = guards.target_categories([], p["picks"], {})
    kept = [
        name for name in p["filed"] if guards.slug(name) in (guards.WEEKLY_THING, guards.FEATURED)
    ]
    return guards.same_set(picked + kept, p["filed"])


def _category_line(p: dict[str, Any]) -> str:
    head = f"- {p['source_id']} {p['title'] or p['gist'] or ''}".rstrip()
    if p["problem"]:
        return f"{head}: left: {p['problem']}"
    added = [name for name in p["target"] if guards.slug(name) not in guards.slugs(p["live"])]
    line = f"{head}: {', '.join(p['target']) or 'nothing'}"
    if not p["check"]:
        line += f" (adds {', '.join(added)})" if added else " (nothing to add)"
    elif p["filed"] is not None:
        line += f"; filed {', '.join(p['filed']) or 'nothing'}"
    if p["new_trip"]:
        line += f"; would make trip {p['new_trip']}"
    return f"{line}. {p['reason']}"


def run_round(
    conn: sqlite3.Connection,
    *,
    micropub: Any,
    labeller: Callable[[filing.Catalog, str], filing.Filing],
    alt_writer: Callable[[str, str], str],
    today: date,
    recheck: int = 0,
    posts: list[str] | None = None,
    alt_limit: int = guards.ALT_CAP,
) -> tuple[Round, dict[str, Any]]:
    """One dry round over ``conn``: proposals and the report's facts."""
    guards.check_running(writing=False)
    work = Round(conn, micropub=micropub, labeller=labeller, alt_writer=alt_writer, today=today)
    proposals = work.propose_categories(work.unfiled(guards.CATEGORY_CAP), check=False)
    checking = list(posts or []) + work.newest_filed(recheck)
    proposals += work.propose_categories(checking, check=True)
    result = {
        "day": today.isoformat(),
        "run": work.run,
        "categories": proposals,
        "new_categories": work.new_categories(proposals),
        "alt": work.propose_alt(alt_limit),
        "drift": work.drift(),
        "featured": work.featured_candidates(),
        "notes": work.notes,
    }
    alt_usage = alt_text.spent()
    if any(alt_usage.values()):
        work._spend(anthropic_client.MODELS["sonnet"], alt_usage)
    result["cost"] = dict(work.cost)
    return work, result


def _labeller(conn: sqlite3.Connection) -> Callable[[filing.Catalog, str], filing.Filing]:
    client = anthropic_client.client("general")
    return lambda catalog, source_id: filing.file_post(client, conn, catalog, source_id)


def _alt_writer(src: str, context: str) -> str:
    return alt_text.generate_alt(image_url=src, context=context)


def _save(made: Made, *, sync: bool) -> None:
    """Record what the round made, and upload; once more from a fresh copy
    if the library moved since the download."""
    for attempt in (1, 2):
        if attempt == 2 and library.cmd_download():
            raise library.LibraryError("could not download the library again")
        with library._library() as conn:
            apply(conn, made)
        if not sync or made.empty():
            return
        try:
            library.cmd_upload()
            return
        except library.LibraryConflict as exc:
            if attempt == 2:
                raise
            print(f"{exc}; saving to a fresh copy", file=sys.stderr)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--recheck", type=int, default=0, help="re-file the N newest filed posts")
    parser.add_argument("--posts", default="", help="comma-separated blog-<id> to re-file")
    parser.add_argument("--alt", type=int, default=guards.ALT_CAP, help="alt drafts this round")
    parser.add_argument("--write", type=Path, help="apply a reviewed proposals file (step 5)")
    parser.add_argument(
        "--no-sync",
        action="store_true",
        help="use the local library as it is and upload nothing (development)",
    )
    args = parser.parse_args(argv)
    load_dotenv(REPO / ".env")
    today = datetime.now(library.CENTRAL).date()
    sync = not args.no_sync
    try:
        guards.check_running(writing=bool(args.write))
        if sync and library.cmd_download():
            return 1
        micropub = Micropub()
        with library._library() as conn:
            if args.write:
                proposals = json.loads(args.write.read_text(encoding="utf-8"))
                work = Round(
                    conn,
                    micropub=micropub,
                    labeller=_labeller(conn),
                    alt_writer=_alt_writer,
                    today=today,
                )
                said = work.write(proposals)
                out = OUT_DIR / f"{today}-written.json"
                out.parent.mkdir(parents=True, exist_ok=True)
                out.write_text(
                    json.dumps(said, indent=2, ensure_ascii=False) + "\n", encoding="utf-8"
                )
                print(json.dumps(said, indent=2, ensure_ascii=False))
            else:
                os.environ["WORKSHOP_ALT_VISION_CAP"] = str(args.alt)
                alt_text.begin_run(purpose="general")
                work, result = run_round(
                    conn,
                    micropub=micropub,
                    labeller=_labeller(conn),
                    alt_writer=_alt_writer,
                    today=today,
                    recheck=args.recheck,
                    posts=[p.strip() for p in args.posts.split(",") if p.strip()],
                    alt_limit=args.alt,
                )
                OUT_DIR.mkdir(parents=True, exist_ok=True)
                (OUT_DIR / f"{today}.json").write_text(
                    json.dumps(result, indent=2, ensure_ascii=False) + "\n", encoding="utf-8"
                )
                text = report(today.isoformat(), result)
                (OUT_DIR / f"{today}.md").write_text(text, encoding="utf-8")
                print(text)
                print(f"proposals: {OUT_DIR / f'{today}.json'}")
        _save(work.made, sync=sync)
    except guards.RoundStop as exc:
        print(f"blog round: {exc}", file=sys.stderr)
        return 2
    except (MicropubError, library.LibraryError, library.LibraryConflict) as exc:
        print(f"blog round: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
