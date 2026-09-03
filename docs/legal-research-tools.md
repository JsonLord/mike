# Legal research tools

The assistant can look up German statutes and court decisions during a chat
turn. Four tools are registered for every chat surface (assistant chat, project
chat, tabular-review chat) in `backend/src/lib/chatTools.ts`, implemented in
`backend/src/lib/legalResearch.ts`. No API keys and no configuration.

| Tool | Source | Returns |
| --- | --- | --- |
| `search_statutes` | Open Legal Data law index | Candidate provisions when the § number is unknown |
| `fetch_statute` | gesetze-im-internet.de (BMJ) | Official consolidated wording currently in force |
| `search_case_law` | Open Legal Data | Decisions with highlighted snippets |
| `fetch_case` | Open Legal Data | Full decision, file number, ECLI, date, source URL |
| `search_official_decisions` | rechtsprechung-im-internet.de | Federal decisions by court / file number / date |
| `fetch_official_decision` | rechtsprechung-im-internet.de | Official text: Tenor, Gründe, Leitsatz, ECLI, norms |

## Sources

**gesetze-im-internet.de** — the Federal Ministry of Justice's official
service. `fetch_statute` takes the law's slug and a section number and tries
`/<book>/__<section>.html`, falling back to `/<book>/art_<section>.html` for
laws numbered by article (GG, EGBGB). Input is tolerant: `242`, `§ 242` and
`Art. 1` all normalize. Pages are ISO-8859-1 and are decoded as such. The
service publishes only the version **in force today** — there are no historic
versions, and the tool's response says so.

**Open Legal Data** (`de.openlegaldata.io`) — a free, community-run corpus of
German decisions, ~425,000 at the time of writing, updated to within days.
Search runs against `/api/cases/search/?text=` (note: the `search` parameter on
the plain `/api/cases/` list endpoint is silently ignored and must not be used).
Supported filters: `start_date`, `end_date`, `court`, `order_by`
(`relevance` | `date` | `most_cited`), and `cited_law_book` + `cited_law_section`,
which finds the decisions citing a given provision.

**rechtsprechung-im-internet.de** — the official service of the Bundesamt für
Justiz, implemented in `backend/src/lib/officialDecisions.ts`. It has no search
API, so the service's index of every decision (`rii-toc.xml`, ~23 MB, 84,130
entries carrying court, date, file number and link) is downloaded and parsed
into a local index, cached at `$DATA_DIR/cache/rii-index.json` (~6.9 MB) and
rebuilt when older than 24 hours. `warmOfficialDecisionIndex()` starts the first
build in the background from `index.ts` after `listen()`, so the server answers
requests immediately (health responds at +0.6s; the index lands at ~+5.6s) and
the first chat lookup does not pay for the download. Concurrent callers share
one build, and a stale index is preferred over none if a rebuild fails.

The service returns an **empty body to clients that do not send a browser
`User-Agent`** — this is why an early probe of it appeared to fail. Decisions
are served as zipped XML and unpacked with JSZip (already a dependency).

Coverage: BGH, BVerfG, BVerwG, BFH, BAG, BSG, BPatG, 2010-01-04 to the present,
federal courts only. The index is metadata (court, date, file number), so it
cannot be searched by subject matter — that is what Open Legal Data is for.
File-number matching is normalized and partial, so `1 BvR` matches the whole
register and `VIa ZR 17/23` finds the single decision. Court names accept
abbreviations or full names (`BGH`, `Bundesgerichtshof`).

## Reachability differs by deployment

Outbound access is not the same everywhere, and this is measured rather than
assumed: `probeLegalSources()` runs at startup, probes each source and performs
one real statute lookup, logging the result. On the Hugging Face Space:

```
[sources] reachable:   openlegaldata (case law search) — HTTP 200 (456ms)
[sources] UNREACHABLE: gesetze-im-internet (statutes)  — UND_ERR_CONNECT_TIMEOUT
[sources] UNREACHABLE: rechtsprechung-im-internet      — UND_ERR_CONNECT_TIMEOUT
```

Both German-government-hosted services refuse connections from that network
(TCP connect timeout, not DNS or TLS); the Cloudflare-fronted Open Legal Data
works. Consequences:

- **Statutes still work.** `fetch_statute` tries gesetze-im-internet first and,
  on a network-level failure, falls back to Open Legal Data's mirror of the same
  text, resolved through a per-book section index (`book__latest=true`, paged
  and cached in memory). The payload then carries `authoritative: false`, the
  `official_url`, and `mirror_last_updated`; the prompt requires the assistant
  to say the wording came from a mirror and to give the official URL. A
  network-level failure also opens a ten-minute circuit breaker, so subsequent
  lookups go straight to the mirror instead of each paying the ~10s TCP connect
  timeout first (measured on the Space: 10.4s for the first statute read, ~0.3s
  after). A successful official read closes the breaker again.
- **The official decision index does not.** `search_official_decisions` returns
  a clear unavailability message and the prompt tells the assistant to fall back
  to `search_case_law` and never to read it as an absence of decisions. After a
  failed build the index backs off for ten minutes, so a call returns
  immediately instead of hanging a chat turn on a connect timeout.

The official-source code is correct and works wherever the host is reachable —
it is the deployment's egress, not the implementation, that limits it.

## Which source wins

The prompt tells the assistant to use Open Legal Data to *find* decisions by
subject matter, then — whenever the decision is from a federal court — to look
it up in the official index by court and file number and read the authoritative
text. Where the two differ, the official text governs. A citation the user hands
over goes straight to `search_official_decisions`. Because the official index
holds no Land or instance-court decisions, the prompt also states that a miss
there says nothing about whether such a decision exists.

## Coverage limits — deliberately surfaced, not hidden

Open Legal Data is **not** Beck-Online or juris, and its coverage is partial.
Both the tool descriptions and the system prompt require the assistant to name
the source it searched, to report an empty result as "nothing found in the
searched free database" rather than "no such case law exists", and to note that
a Beck-Online or juris search is still needed where the matter is important.

Search results deliberately omit the **court name, the date and the file
number**. All three come only from `fetch_case`, so a citation cannot be
assembled from search output at all — the model has to read the decision before
it can name it. Results are marked `citable: false` and carry a `how_to_use`
note saying the snippets establish nothing on their own.

This was tightened after a production answer cited five decisions without a
single `fetch_case` call, inventing one Minderungsquote outright and presenting
two figures from parties' submissions as courts' holdings. Prose instruction
alone did not hold; withholding the data does. The prompt additionally requires
the model to check that a figure appears in the Tenor or Entscheidungsgründe
rather than in a party's contention, and forbids using the `[N]`/`<CITATIONS>`
document mechanism for legal sources.

## Observability

Every research tool call logs one line — tool, arguments, which source
answered or the error, and how long it took:

```
[legal] search_case_law {"query":"Mietminderung Schimmel","limit":2} -> via Open Legal Data, 62 matches (772ms)
[legal] fetch_statute {"book":"bgb","section":"242"} -> via gesetze-im-internet.de (670ms)
[legal] fetch_case {"case_id":"bad"} -> error: case_id must be the numeric id … (0ms)
```

A fallback to the statute mirror is marked `NON-AUTHORITATIVE`. Together with
the startup `[sources]` lines this makes two otherwise invisible questions
answerable from the deployment's logs: whether the model is calling the tools
at all, and which source actually served each answer.

## Failure behaviour

Both sources are third-party. Every lookup runs under a timeout (15s search,
25s fetch) and returns a structured `{ error }` to the model instead of
throwing, so an unreachable source degrades into the assistant saying what it
could not verify rather than failing the turn.

## Not integrated

**Beck-Online and juris** have no public API; access is per-seat and their
terms prohibit automated retrieval. Integrating them requires a commercial
agreement with the publisher, not a code change.

**Full-text search of the official corpus.** The official service exposes no
text index, and the TOC carries metadata only, so subject-matter search there
would mean fetching and indexing 84,130 decisions locally — far beyond the
scope of a per-container cache. Full-text search therefore runs against Open
Legal Data, with the official source used to verify and read what it finds.
