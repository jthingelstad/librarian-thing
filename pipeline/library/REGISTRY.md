# Public registry archive observation

An ordinary `upload` attaches `things-revision-algorithm=things-snapshot-v1`
and `things-revision=<64 lowercase hex>` to the existing private
`artifacts/library.db` object. No event, extra upload, new grant, corpus build
or public library download is needed. Sync already reads that object's HEAD.

`store.upload` takes a consistent SQLite backup, including committed WAL
contents. It reads only `files.content` at `things/things.json`, origin `xyz`,
from that frozen backup, then uploads those same bytes with the original
`If-Match` / first-copy `If-None-Match` condition. A concurrent local edit
cannot change the metadata's object. A losing S3 writer still retries the
round normally. Private references, reader tables and other file rows never
participate in the public revision. The private database remains private.
An absent registry row emits no revision. Unsupported content emits no
revision and a fixed warning without any payload or exception text.

## things-snapshot-v1

This is the **importer's document snapshot**, not the separate `xyz/refreshed`
event hash. Retain exactly `site`, `things`, `topics`, `history`; discard
top-level `generated`, `featured` and any other top-level fields, as the
importer does. Keep every nested field. Sort things by id, topics by id,
history by (date, id), using UTF-8 byte order and stable ties. `site` and
those sort keys must be strings; things is nonempty with unique ids;
topics/history are arrays (null becomes empty). Unsupported shapes cannot
be compared. Nested array order and string whitespace remain significant.

Hash SHA-256 over ASCII `things-snapshot-v1` + LF + this recursive encoding:

| Value | Encoding |
|---|---|
| null | ASCII `n` |
| boolean | ASCII `t` or `f` |
| integer | ASCII `i`, base-10 integer, `;` (negative zero becomes zero) |
| string | ASCII `s`, decimal UTF-8 byte length, `:`, the UTF-8 bytes |
| array | `[` + encoded values in order + `]` |
| object | `{` + encoded key/value pairs, keys sorted by UTF-8 bytes + `}` |

Only finite integral numbers within ±9007199254740991 and well-formed Unicode
strings are supported. There is no Unicode normalization. Key order, JSON
formatting and a regenerated site's clock cannot change the revision.
`tests/fixtures/registry-revisions.json` is the same synthetic vector set as
Sync's `test/fixtures/registry-revisions.json`; both languages assert fixed
expected hashes, including Unicode, safe integers, reordered fields/lists,
and an actual imported body change. The tests also compare normalization
against the real importer, not a second invented import shape.

## Meaning and release

Equality proves that the versioned stored archive holds the normalized
current public registry. Different revisions prove a document difference;
missing metadata does not prove a missing import. A HEAD/version/upload time
is storage evidence, not the source's edit time or an item's publication
time. This does not prove corpus freshness, actual serving or an individual
Thing arrival. Sync creates no Thing journey or propagation lag.

No live upload is performed just to add telemetry. After merge the next
ordinary GitHub library round checks out main at 12:17 UTC daily (07:17 CDT,
06:17 CST). The Mac round also needs the updated producer code; its active
checkout is not switched by this change. Until a real normal upload and
subsequent Sync HEAD are observed, live arrival acceptance is pending.
The deploy workflow excludes only `library/store.py` and `library/registry.py`
from code-forced corpus builds; normal input-staleness checks still apply.
