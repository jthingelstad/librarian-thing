#!/usr/bin/env python3
"""
Blog abstracts: one to three plain sentences per titled post, for skimming.

Search results and listings show a blog post's title and a clipped first
chunk. This job gives each titled post (``post_kind: post``) a short neutral
abstract written by Claude Sonnet and stores it in a sidecar keyed by
``microblog_id``:

    data/librarian/blog-abstracts.json
    {microblog_id: {body_hash, abstract, model, generated_at, pronouns_checked?}}

The blog corpus build merges it onto the post records as ``abstract`` with
``abstract_source: "generated"`` (``librarian_core/abstracts.py``). It is
display metadata: never chunk text, never embedded, never matched as Jamie's
words. Microposts need no call; they are their own abstract.

Idempotent and resumable: an entry whose ``body_hash`` matches the post is
skipped, so a re-run pays only for new or edited posts, and the sidecar is
flushed as results arrive. A post that fails permanently is recorded with an
``error`` and is not retried until the post changes or its entry is deleted.

The posts are first person, so any pronoun for Jamie is the model guessing
from the name. The prompt forbids one, and as a guard an abstract that still
has he/him/his/himself gets one more short call, with the post attached so
the model can tell whose pronoun it is, that replaces only the pronouns
referring to Jamie; it is then marked ``pronouns_checked`` and not sent
again. Sonnet, not Haiku (2026-09-29): Haiku wrote "his wife Tammy" through
an explicit counter-example, misread whose "his" was whose in the repair,
and invented relations ("Jamie's grandson Tyler").
More than a handful of posts go through the Message Batches API (half
price); the batch id is kept in ``tmp/blog-abstracts-batch.json`` so an
interrupted run picks the same batch back up.

    uv run --locked python pipeline/blog/abstracts.py --dry-run
    uv run --locked python pipeline/blog/abstracts.py --sample 5
    uv run --locked python pipeline/blog/abstracts.py
"""

from __future__ import annotations

import argparse
import html
import json
import re
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from typing import Any

import anthropic
from dotenv import load_dotenv
from librarian_core.abstracts import ABSTRACT_MAX_CHARS, GENERATED_MAX_CHARS, clip_abstract
from librarian_core.corpus import body_hash, read_issue
from librarian_core.paths import BLOG_ABSTRACTS_PATH, BLOG_DIR

sys.path.insert(0, str(Path(__file__).resolve().parent))
import anthropic_client  # noqa: E402

ROOT = Path(__file__).resolve().parents[2]
BATCH_STATE = ROOT / "tmp" / "blog-abstracts-batch.json"

MODEL = anthropic_client.MODELS["sonnet"]
RATE_MODEL = MODEL
BATCH_DISCOUNT = 0.5
MAX_TOKENS = 300
# More pending posts than this go through the Batches API; a normal week's
# handful is quicker as direct calls.
DIRECT_MAX = 25
CONCURRENCY = 4
MAX_BODY_CHARS = 100_000
# Rough planning numbers for --dry-run (no network): characters per input
# token for markdown prose with URLs, and output tokens per abstract.
CHARS_PER_TOKEN = 3.5
EST_OUTPUT_TOKENS = 90

SYSTEM_PROMPT = """\
You write the abstract for one post from Jamie Thingelstad's personal blog, \
thingelstad.com. The abstract is display metadata: it appears under the \
post's title in search results and archive listings so a reader, or an AI \
agent, can tell what the post contains without opening it.

Write one to three sentences of plain text, 20 to 45 words in all and \
never more than 300 characters, so choose what matters most rather than \
listing everything.

- Say what the post says: its subject, the specific things it covers \
(people, places, products, books, companies and events it names) and its \
main point or conclusion. When the post lists reasons, steps or \
recommendations, name the main ones briefly.
- Neutral third person, present tense. Refer to the author as "Jamie" \
("Jamie describes...", "Jamie argues...", "Jamie links to..."). Do not write \
in Jamie's voice.
- Never use a pronoun for Jamie (no he, she, they, his, her, their or \
himself). Write "Jamie's wife Tammy", never "his wife Tammy"; repeat the name \
or rephrase so the sentence needs no pronoun. Other people keep the pronouns \
the post uses for them.
- Use only what the post itself states. Do not add background, dates, \
outcomes or opinions from outside knowledge, and do not guess at motives or \
feelings the post does not express. Keep each claim as certain or as \
hedged as the post makes it.
- No evaluative or promotional language of your own: no "insightful", \
"thoughtful", "fascinating", "must-read", no hype and no calls to action. \
Jamie's own opinions are fine when attributed ("Jamie finds...").
- If the post mainly points to or quotes someone else's work, name the \
source and what it says, then what Jamie adds, if anything.
- If the post is mostly photos, say what the text and photo descriptions \
show. If it has almost no text (only a title and an embedded photo \
collection, say), write one short sentence from what is there, such as \
"Jamie shares photos from...". Always write an abstract; never reply about \
the request itself.
- Do not begin with "This post", "In this post" or the title.

Output only the abstract: no heading, label, quotation marks, markdown or \
preamble."""

_IMG_TAG_RE = re.compile(r"<img\b[^>]*>", re.I | re.S)
_ALT_ATTR_RE = re.compile(r"\balt\s*=\s*([\"'])(.*?)\1", re.I | re.S)
_MD_IMG_RE = re.compile(r"!\[([^\]]*)\]\([^)]*\)")
_HTML_LINK_RE = re.compile(r"<a\b[^>]*?\bhref\s*=\s*([\"'])(.*?)\1[^>]*>(.*?)</a\s*>", re.I | re.S)
_SHORTCODE_RE = re.compile(r"\{\{<\s*([\w-]+)\s*(.*?)\s*/?>\}\}", re.S)
_BLOCKQUOTE_RE = re.compile(r"<(/?)blockquote\b[^>]*>", re.I)
_OTHER_TAG_RE = re.compile(r"<(?!/?blockquote>)[^>]+>")
_LABEL_RE = re.compile(r"^(?:abstract|summary)\s*:\s*", re.I)
_EMPHASIS_RE = re.compile(r"(?<![\w*])\*([^*\n]+)\*(?![\w*])|(?<!\w)_([^_\n]+)_(?!\w)")
# The model talking about the task instead of doing it ("I don't have access
# to...", "Could you provide..."). An abstract is third person about Jamie.
_NOT_AN_ABSTRACT_RE = re.compile(
    r"^(?:I|I'm|I’m|Sorry|Unfortunately)\b|\b(?:[Cc]ould you (?:provide|share)|I would need)\b"
)
_MASCULINE_PRONOUN_RE = re.compile(r"\b(?:he|him|his|himself)\b", re.I)
PRONOUN_PASSES = 3

PRONOUN_PROMPT = """\
You edit one short abstract of a blog post by Jamie Thingelstad. The post is \
given for reference: Jamie wrote it in the first person, so "I", "me" and \
"my" in the post are Jamie. Use it only to tell who each pronoun in the \
abstract refers to.

Replace every pronoun in the abstract that refers to Jamie (he, him, his, \
himself) with "Jamie" or "Jamie's", or rephrase that phrase minimally so no \
pronoun refers to Jamie. Where the name would repeat within a few words, \
rephrase instead ("Jamie and his wife Tammy" becomes "Jamie and wife Tammy"). \
A pronoun that refers to anyone else stays exactly as it is; do not replace \
it with a name. Change nothing else, even where the abstract and the post \
disagree. Output only the edited abstract."""


def _photo(alt: str) -> str:
    alt = " ".join(alt.split())
    return f"[Photo: {alt}]" if alt else "[Photo]"


def _img_tag_photo(match: re.Match[str]) -> str:
    alt = _ALT_ATTR_RE.search(match.group(0))
    return _photo(alt.group(2) if alt else "")


def prompt_body(body: str) -> str:
    """The post as the model reads it: photos become ``[Photo: alt]``,
    shortcodes a bracketed note, HTML links markdown links, other markup
    (bar blockquotes, which mark quoted material) is dropped."""
    text = _IMG_TAG_RE.sub(_img_tag_photo, body or "")
    text = _MD_IMG_RE.sub(lambda m: _photo(m.group(1)), text)
    text = _SHORTCODE_RE.sub(lambda m: f"[Embedded {m.group(1)} {m.group(2)}]".strip(), text)
    text = _HTML_LINK_RE.sub(lambda m: f"[{m.group(3).strip()}]({m.group(2)})", text)
    text = _BLOCKQUOTE_RE.sub(lambda m: f"<{m.group(1)}blockquote>", text)
    text = _OTHER_TAG_RE.sub(" ", text)
    text = html.unescape(text)
    text = re.sub(r"[ \t]+", " ", text)
    text = re.sub(r"\n\s*\n+", "\n\n", text).strip()
    return text[:MAX_BODY_CHARS]


def collect_posts(blog_dir: Path = BLOG_DIR) -> list[dict[str, Any]]:
    """Every titled (non-micropost) post with text, oldest path first. The
    ``body_hash`` is computed exactly as the blog corpus stamps its post
    records, which is what the merge compares against."""
    posts: dict[str, dict[str, Any]] = {}
    for path in sorted(blog_dir.rglob("*.md")):
        metadata, body = read_issue(path)
        if str(metadata.get("post_kind") or "post").strip() == "micropost":
            continue
        microblog_id = metadata.get("microblog_id")
        text = prompt_body(body)
        if microblog_id is None or not text:
            continue
        posts[str(microblog_id)] = {
            "microblog_id": str(microblog_id),
            "title": str(metadata.get("title") or "").strip(),
            "published": str(metadata.get("published") or "")[:10],
            "body_hash": body_hash(body),
            "text": text,
        }
    return list(posts.values())


def select_pending(posts: list[dict[str, Any]], sidecar: dict[str, Any]) -> list[dict[str, Any]]:
    """Posts with no sidecar entry for their current text. A done or failed
    entry with the same body_hash is skipped; an edit changes the hash."""
    return [
        post
        for post in posts
        if (sidecar.get(post["microblog_id"]) or {}).get("body_hash") != post["body_hash"]
    ]


def user_message(post: dict[str, Any]) -> str:
    lines = [f"Title: {post['title']}" if post["title"] else "Title: (untitled)"]
    if post.get("published"):
        lines.append(f"Published: {post['published']}")
    return "\n".join(lines) + f"\n\n<post>\n{post['text']}\n</post>"


def request_params(post: dict[str, Any]) -> dict[str, Any]:
    return {
        "model": MODEL,
        "max_tokens": MAX_TOKENS,
        "system": SYSTEM_PROMPT,
        "messages": [{"role": "user", "content": user_message(post)}],
    }


def clean_abstract(text: str, max_chars: int = ABSTRACT_MAX_CHARS) -> str:
    """Plain, single-paragraph, clipped. Strips a heading line, an
    ``Abstract:`` label, markdown emphasis and wrapping quotes the model
    might slip in despite the prompt."""
    text = re.sub(r"^#+\s*[^\n]*\n+", "", (text or "").strip())
    text = " ".join(text.replace("**", "").replace("__", "").replace("`", "").split())
    text = _EMPHASIS_RE.sub(lambda m: m.group(1) or m.group(2), text)
    text = _LABEL_RE.sub("", text)
    if len(text) >= 2 and text[0] in '"“' and text[-1] in '"”':
        text = text[1:-1].strip()
    return clip_abstract(text, max_chars)


def _now() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def error_entry(post: dict[str, Any], error: str) -> dict[str, Any]:
    return {"body_hash": post["body_hash"], "error": error, "model": MODEL, "generated_at": _now()}


def entry_from_message(message: Any, post: dict[str, Any]) -> dict[str, Any]:
    if getattr(message, "stop_reason", None) == "refusal":
        return error_entry(post, "refusal")
    text = " ".join(block.text for block in message.content if block.type == "text")
    abstract = clean_abstract(text)
    if not abstract:
        return error_entry(post, "empty")
    if _NOT_AN_ABSTRACT_RE.search(abstract):
        return error_entry(post, "not_an_abstract")
    return {
        "body_hash": post["body_hash"],
        "abstract": abstract,
        "model": MODEL,
        "generated_at": _now(),
    }


def needs_pronoun_repair(entry: dict[str, Any]) -> bool:
    abstract = entry.get("abstract") or ""
    return bool(_MASCULINE_PRONOUN_RE.search(abstract)) and not entry.get("pronouns_checked")


def repair_pronouns(
    client: anthropic.Anthropic,
    entries: dict[str, dict[str, Any]],
    usage: Usage,
    sidecar_path: Path | None = None,
    posts: dict[str, dict[str, Any]] | None = None,
) -> int:
    """Rewrite pronouns for Jamie out of every abstract that has one, in
    place. An edit that still has he/him/his is sent again (the model can
    miss one of several) until it stops changing: what is left then refers
    to someone else. An edit that comes back empty, as a reply about the
    task, or much shorter than the original is not stored and is retried on
    the next run. Returns the number of abstracts marked checked."""
    keys = [key for key, entry in entries.items() if needs_pronoun_repair(entry)]
    lock = threading.Lock()
    checked = 0

    def edit(key: str, text: str) -> str | None:
        post = (posts or {}).get(key)
        content = f"<abstract>\n{text}\n</abstract>"
        if post:
            content = f"<post>\n{post['text']}\n</post>\n\n{content}"
        try:
            message = client.messages.create(
                model=MODEL,
                max_tokens=MAX_TOKENS,
                system=PRONOUN_PROMPT,
                messages=[{"role": "user", "content": content}],
            )
        except anthropic.RateLimitError, anthropic.APIStatusError, anthropic.APIConnectionError:
            print(f"  pronoun repair failed: {key} (next run retries)")
            return None
        usage.add(message.usage, batch=False)
        edited = clean_abstract(
            " ".join(b.text for b in message.content if b.type == "text"), GENERATED_MAX_CHARS
        )
        if not edited or _NOT_AN_ABSTRACT_RE.search(edited) or len(edited) < 0.8 * len(text):
            print(f"  pronoun repair rejected: {key} (next run retries)")
            return None
        return edited

    def work(key: str) -> None:
        nonlocal checked
        edited = entries[key]["abstract"]
        for _ in range(PRONOUN_PASSES):
            previous = edited
            edited = edit(key, previous)
            if edited is None:
                return
            if edited == previous or not _MASCULINE_PRONOUN_RE.search(edited):
                break
        with lock:
            entries[key]["abstract"] = edited
            entries[key]["pronouns_checked"] = True
            checked += 1
            if sidecar_path is not None and checked % 25 == 0:
                write_json(sidecar_path, entries)

    with ThreadPoolExecutor(max_workers=CONCURRENCY) as pool:
        for future in as_completed([pool.submit(work, key) for key in keys]):
            future.result()
    if sidecar_path is not None and keys:
        write_json(sidecar_path, entries)
    return checked


def load_json(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8")) if path.exists() else {}


def write_json(path: Path, data: dict[str, Any]) -> None:
    """Write via a temp file and rename, so a crash never leaves half a file."""
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(
        json.dumps(data, indent=1, sort_keys=True, ensure_ascii=False) + "\n", encoding="utf-8"
    )
    tmp.replace(path)


class Usage:
    def __init__(self) -> None:
        self.calls = self.input_tokens = self.output_tokens = 0
        self.batch_input_tokens = self.batch_output_tokens = 0
        self._lock = threading.Lock()

    def add(self, usage: Any, *, batch: bool) -> None:
        with self._lock:
            self.calls += 1
            tokens_in = getattr(usage, "input_tokens", 0) or 0
            tokens_out = getattr(usage, "output_tokens", 0) or 0
            self.input_tokens += tokens_in
            self.output_tokens += tokens_out
            if batch:
                self.batch_input_tokens += tokens_in
                self.batch_output_tokens += tokens_out

    def cost(self) -> float:
        full = anthropic_client.cost_usd(
            RATE_MODEL, input_tokens=self.input_tokens, output_tokens=self.output_tokens
        )
        batch_share = anthropic_client.cost_usd(
            RATE_MODEL, input_tokens=self.batch_input_tokens, output_tokens=self.batch_output_tokens
        )
        return (full or 0.0) - (batch_share or 0.0) * (1 - BATCH_DISCOUNT)


def estimate(posts: list[dict[str, Any]]) -> tuple[int, int, float, float]:
    """Projected (input tokens, output tokens, direct $, batch $)."""
    chars = sum(len(SYSTEM_PROMPT) + len(user_message(post)) for post in posts)
    tokens_in = int(chars / CHARS_PER_TOKEN)
    tokens_out = EST_OUTPUT_TOKENS * len(posts)
    direct = anthropic_client.cost_usd(RATE_MODEL, input_tokens=tokens_in, output_tokens=tokens_out)
    return tokens_in, tokens_out, direct or 0.0, (direct or 0.0) * BATCH_DISCOUNT


def run_direct(
    client: anthropic.Anthropic,
    posts: list[dict[str, Any]],
    sidecar: dict[str, Any] | None,
    usage: Usage,
    sidecar_path: Path = BLOG_ABSTRACTS_PATH,
) -> dict[str, dict[str, Any]]:
    """Plain calls with modest concurrency. With ``sidecar`` None nothing is
    written (the --sample preview). Transient failures (rate limit, 5xx,
    connection) are left out so the next run retries them."""
    results: dict[str, dict[str, Any]] = {}
    lock = threading.Lock()

    def work(post: dict[str, Any]) -> None:
        try:
            message = client.messages.create(**request_params(post))
        except anthropic.RateLimitError:
            print(f"  rate limited: {post['microblog_id']} (next run retries)")
            return
        except anthropic.APIStatusError as error:
            if error.status_code >= 500:
                print(f"  api {error.status_code}: {post['microblog_id']} (next run retries)")
                return
            entry = error_entry(post, f"api_{error.status_code}")
        except anthropic.APIConnectionError:
            print(f"  connection error: {post['microblog_id']} (next run retries)")
            return
        else:
            usage.add(message.usage, batch=False)
            entry = entry_from_message(message, post)
        with lock:
            results[post["microblog_id"]] = entry
            if sidecar is not None:
                sidecar[post["microblog_id"]] = entry
                if len(results) % 10 == 0:
                    write_json(sidecar_path, sidecar)

    with ThreadPoolExecutor(max_workers=CONCURRENCY) as pool:
        for future in as_completed([pool.submit(work, post) for post in posts]):
            future.result()
    if sidecar is not None:
        write_json(sidecar_path, sidecar)
    return results


def submit_batch(client: anthropic.Anthropic, posts: list[dict[str, Any]]) -> dict[str, Any]:
    requests = [
        {"custom_id": f"mb-{post['microblog_id']}", "params": request_params(post)}
        for post in posts
    ]
    batch = client.messages.batches.create(requests=requests)
    state = {
        "batch_id": batch.id,
        "submitted_at": _now(),
        "posts": {
            f"mb-{post['microblog_id']}": {
                "microblog_id": post["microblog_id"],
                "body_hash": post["body_hash"],
            }
            for post in posts
        },
    }
    write_json(BATCH_STATE, state)
    print(f"submitted batch {batch.id}: {len(requests)} requests")
    return state


def collect_batch(
    client: anthropic.Anthropic,
    state: dict[str, Any],
    sidecar: dict[str, Any],
    usage: Usage,
    poll_seconds: int,
    sidecar_path: Path = BLOG_ABSTRACTS_PATH,
) -> None:
    """Wait for the batch to end, then stream its results into the sidecar.
    An invalid request is recorded as an error; a server error, expiry or
    cancellation is left out so the next run resubmits it."""
    batch_id = state["batch_id"]
    while True:
        batch = client.messages.batches.retrieve(batch_id)
        counts = batch.request_counts
        print(
            f"  {batch.processing_status}: processing {counts.processing}, "
            f"succeeded {counts.succeeded}, errored {counts.errored}, "
            f"expired {counts.expired}, canceled {counts.canceled}"
        )
        if batch.processing_status == "ended":
            break
        time.sleep(poll_seconds)

    written = 0
    for item in client.messages.batches.results(batch_id):
        post = state["posts"].get(item.custom_id)
        if post is None:
            continue
        result = item.result
        if result.type == "succeeded":
            usage.add(result.message.usage, batch=True)
            entry = entry_from_message(result.message, post)
        elif result.type == "errored":
            error_type = getattr(getattr(result.error, "error", None), "type", "") or ""
            if error_type != "invalid_request_error":
                continue
            entry = error_entry(post, "invalid_request")
        else:
            continue
        sidecar[post["microblog_id"]] = entry
        written += 1
        if written % 100 == 0:
            write_json(sidecar_path, sidecar)
            print(f"  {written} results written")
    write_json(sidecar_path, sidecar)
    BATCH_STATE.unlink(missing_ok=True)
    print(f"batch {batch_id}: {written} results written")


def evenly_spaced(items: list[Any], count: int) -> list[Any]:
    if count >= len(items):
        return list(items)
    step = len(items) / count
    return [items[int(i * step + step / 2)] for i in range(count)]


def main(argv: list[str] | None = None) -> int:
    sys.stdout.reconfigure(line_buffering=True)
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--dry-run", action="store_true", help="count and project cost only")
    parser.add_argument("--sample", type=int, default=0, help="preview N abstracts; writes nothing")
    parser.add_argument("--limit", type=int, default=0, help="cap this run at N posts")
    parser.add_argument("--mode", choices=("auto", "batch", "direct"), default="auto")
    parser.add_argument("--poll-seconds", type=int, default=30)
    args = parser.parse_args(argv)

    load_dotenv(ROOT / ".env")
    sidecar = load_json(BLOG_ABSTRACTS_PATH)
    usage = Usage()
    client = None
    if not args.dry_run and not args.sample and BATCH_STATE.exists():
        client = anthropic_client.client("general")
        state = load_json(BATCH_STATE)
        print(f"resuming batch {state['batch_id']} ({len(state['posts'])} requests)")
        collect_batch(client, state, sidecar, usage, args.poll_seconds)

    posts = collect_posts()
    pending = select_pending(posts, sidecar)
    live = {post["microblog_id"] for post in posts}
    orphaned = sum(1 for key in sidecar if key not in live)
    print(
        f"titled posts: {len(posts)} | in sidecar: {len(sidecar)} "
        f"(orphaned {orphaned}) | to do: {len(pending)}"
    )
    if args.limit:
        pending = pending[: args.limit]
    tokens_in, tokens_out, direct_cost, batch_cost = estimate(pending)
    print(
        f"projected: ~{tokens_in:,} tokens in, ~{tokens_out:,} out; "
        f"${direct_cost:.2f} direct, ${batch_cost:.2f} batch"
    )
    repairs = sum(1 for entry in sidecar.values() if needs_pronoun_repair(entry))
    if repairs:
        print(f"pronoun repair pending: {repairs} abstracts (one short call each)")
    if args.dry_run:
        return 0

    if args.sample:
        client = client or anthropic_client.client("general")
        chosen = evenly_spaced(pending or posts, args.sample)
        results = run_direct(client, chosen, None, usage)
        repair_pronouns(client, results, usage, posts={p["microblog_id"]: p for p in chosen})
        for post in chosen:
            entry = results.get(post["microblog_id"], {"error": "transient"})
            text = entry.get("abstract") or f"ERROR {entry.get('error')}"
            print(f"\n[{post['microblog_id']}] {post['published']} {post['title']}")
            print(f"  ({len(text)} chars) {text}")
        print(f"\nsample: {usage.input_tokens} in / {usage.output_tokens} out, ${usage.cost():.4f}")
        return 0

    if pending:
        client = client or anthropic_client.client("general")
        use_batch = args.mode == "batch" or (args.mode == "auto" and len(pending) > DIRECT_MAX)
        if use_batch:
            state = submit_batch(client, pending)
            collect_batch(client, state, sidecar, usage, args.poll_seconds)
        else:
            run_direct(client, pending, sidecar, usage)

    to_repair = sum(1 for entry in sidecar.values() if needs_pronoun_repair(entry))
    if to_repair:
        client = client or anthropic_client.client("general")
        print(f"pronoun repair: {to_repair} abstracts")
        by_id = {post["microblog_id"]: post for post in posts}
        fixed = repair_pronouns(client, sidecar, usage, BLOG_ABSTRACTS_PATH, by_id)
        print(f"pronoun repair: {fixed} checked, {to_repair - fixed} left for the next run")

    done = sum(1 for entry in sidecar.values() if entry.get("abstract"))
    failed = sum(1 for entry in sidecar.values() if entry.get("error"))
    still_pending = len(select_pending(posts, sidecar))
    print(
        f"sidecar: {done} abstracts, {failed} failed, {still_pending} still to do "
        f"-> {BLOG_ABSTRACTS_PATH}"
    )
    print(
        f"this run: {usage.calls} results, {usage.input_tokens:,} tokens in / "
        f"{usage.output_tokens:,} out, ${usage.cost():.4f}"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
