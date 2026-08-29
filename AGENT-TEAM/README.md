# AGENT-TEAM — objective owners for the Librarian

Three objective owners maintain the Librarian: the archive, the corpora, and the
API that answers from them. Each owns a durable outcome through measurement,
implementation, verification, deployment, and acceptance. There is no
dispatcher, Build Manager, Product Manager, or Team Manager, and building is a
capability of every owner. Do not add more agents; new names would split
outcomes these three already own.

## The team

| Objective | File | Cadence | Primary question |
|---|---|---|---|
| **Run the Librarian** | `run-librarian.md` | Weekly Saturday, and after deploys, alarms, or incidents | Is the Librarian API, MCP surface, and deploy pipeline healthy, observable, secure enough, and inexpensive? |
| **Keep the Archive True** | `keep-archive-true.md` | Weekly Sunday morning, and when ingest changes | Are the archive data, corpus builds, and graph artifacts current, complete, and correct? |
| **Improve Thingy** | `improve-thingy.md` | Weekly Monday, after the scheduled answer eval | Are Thingy's answers grounded, cited, honest, and improving? |

Choose the owner by the primary failed outcome, not by the file being edited:

- **Run the Librarian** when execution, delivery, uptime, alarms, auth, deploy
  mechanics, or cost is wrong.
- **Keep the Archive True** when canonical content, ingest, corpus builds, or
  graph artifacts are stale, missing, or wrong.
- **Improve Thingy** when the archive and infrastructure are sound but the
  answers — grounding, citation, honesty, tool use — are not.

Cross-cutting work keeps one originating owner through acceptance; the other
objectives contribute a standard or a capability, not a handoff queue.

## How Jamie engages the team

Jamie can start with the outcome instead of choosing a role or preparing a ticket:

- `Run <objective> now and own the highest-impact measured gap.`
- `Investigate <symptom>; choose the owner by the failed outcome, not the file.`
- `Show me team status only; make no changes.`
- `What across this team needs Jamie?`
- `Resume the active watch for <objective or issue>.`

## Jamie decides

Reader-visible behavior changes, `/retrieve` contract major bumps, corpus
schema changes, embed model changes, and anything touching secrets or
credentials remain Jamie decisions. Ask one concrete yes/no question with
evidence and the smallest useful version.

## Issue policy

Issues are an exception ledger for multi-run work, external blockers, and Jamie
decisions. Same-run safe fixes are made and verified without a routing ticket.
Every open issue carries exactly one objective label:

| Label | Owner |
|---|---|
| `objective:run` | Run the Librarian |
| `objective:archive` | Keep the Archive True |
| `objective:improve` | Improve Thingy |

Descriptive labels stay descriptive; `decision` means Jamie must answer before
the objective can continue.

## North star

The Librarian should feel like a faithful archive with a sharp reference desk:
answers traceable to canonical content, infrastructure quiet and cheap, and a
healthy no-op counted as success over invented work.
