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

## Coverage limits — deliberately surfaced, not hidden

Open Legal Data is **not** Beck-Online or juris, and its coverage is partial.
Both the tool descriptions and the system prompt require the assistant to name
the source it searched, to report an empty result as "nothing found in the
searched free database" rather than "no such case law exists", and to note that
a Beck-Online or juris search is still needed where the matter is important.

Search results deliberately omit the file number, which is only available from
`fetch_case`. This forces the model through a fetch before it can cite a
decision, so citations come from the record rather than from a snippet.
The prompt requires the form: court, Aktenzeichen, date — e.g.
"OLG Köln, Urteil v. 17.09.2025 – 11 U 125/23" — plus ECLI and source URL.

## Failure behaviour

Both sources are third-party. Every lookup runs under a timeout (15s search,
25s fetch) and returns a structured `{ error }` to the model instead of
throwing, so an unreachable source degrades into the assistant saying what it
could not verify rather than failing the turn.

## Not integrated

**Beck-Online and juris** have no public API; access is per-seat and their
terms prohibit automated retrieval. Integrating them requires a commercial
agreement with the publisher, not a code change.

**rechtsprechung-im-internet.de** (the official federal-courts service, ~84,000
decisions from BGH, BVerwG, BFH, BAG, BSG, BPatG) is reachable and usable —
it requires a browser `User-Agent`, serves a 23 MB `rii-toc.xml` index of every
decision, and returns each decision as a zipped XML document. It offers no
search API, so using it means building and refreshing a local index of that
TOC. That is a separate piece of work from the tools above.
