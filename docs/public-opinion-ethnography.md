# Turning Mike into an agentic public-opinion study (investigation)

Status: proposal. None of this is implemented. This repo, and the Space built
from it, has no social or public-opinion feature today. The assistant is a
legal-document tool whose only outside sources are German statutes and case law
(`LEGAL_RESEARCH_TOOLS` in `backend/src/lib/chatTools.ts`).

## What the codebase already gives us

| Piece | Where | Why it helps |
|---|---|---|
| Tool-calling loop for Claude, Gemini, OpenAI and OpenAI-compatible models | `backend/src/lib/llm/*` | New sources are just more tools |
| Tool registry and dispatch | `chatTools.ts` (`TOOLS`, `LEGAL_RESEARCH_TOOLS`, `runToolCalls`) | One place to add them |
| Tabular review: one prompt per column, run across many rows | `routes/tabular.ts` | Ready-made coding sheet: rows = collected posts, columns = stance, frame, emotion, actor |
| Workflows (saved prompts) | `routes/workflows.ts`, `builtinWorkflows.ts` | Store study protocols |
| Citations that must be fetched before they can be cited | `chatTools.ts` citation handling | The same rule should apply to quotes from posts |
| Projects with documents | `routes/projects.ts` | One project per study; fieldnotes are its documents |

What's missing:

- no general web access (no search and no page fetch),
- no MCP client,
- a turn stops after 10 tool iterations (`maxIterations: 10` in `chatTools.ts`),
  which is far too few for a roaming session,
- nowhere to store collected material other than chat history.

## Target design

"Free roaming" should still be reproducible. The agent works in rounds, and
each round leaves a written record.

1. **Research question and field definition.** The user states the topic,
   population, languages, regions and time window. The agent drafts a field map
   (communities, hashtags, outlets and forums where the topic is discussed) and
   saves it as a project document.
2. **Explore.** The agent searches and follows links, and snowballs from
   community to community: a thread cites a subreddit, a Bluesky account links a
   forum, a news comment section points to a Telegram channel. Every page it
   reads is stored as a *source record*: URL, retrieval time, platform, author
   handle (hashed), text, engagement numbers, and why it was opened.
3. **Fieldnotes.** After each round the agent writes a memo: what it saw, which
   voices were missing, and where it will go next and why. This is the
   ethnographic part: reflexive, iterative, driven by theoretical sampling
   rather than one keyword scrape.
4. **Code.** Source records are pushed into a tabular review, with columns for
   stance, argument or frame, emotion, the actor blamed or credited, and a
   verbatim quote. The existing per-cell citation machinery ties each coded
   cell to its record.
5. **Triangulate.** Compare the qualitative picture with quantitative signals:
   search interest, news volume and tone, Wikipedia pageviews, and published
   polls where they exist.
6. **Saturation check.** Stop when new rounds stop producing new codes. Report
   the code frequency per round so saturation is visible, not just asserted.
7. **Report.** Findings with quotes that link to stored records, a sampling
   log, and a limitations section: platform skew, bots, no representativeness
   claims.

## Sources and MCP servers

Prefer official or open APIs over scraping. They are more stable, and most
platforms' terms forbid scraping.

| Need | Option | Notes |
|---|---|---|
| Web search | Brave Search MCP, Tavily, Exa, SearXNG (self-hosted) | Needed to find the field at all |
| Read any page as text | Jina Reader (`r.jina.ai`; you have a `jina` Space), Firecrawl MCP, `fetch` MCP reference server | Cheapest way to follow links |
| JS-heavy or login-walled pages | Playwright MCP (Microsoft), or your `browser-use-webui` Space | Heavy, so use only when a reader fails |
| Reddit | Reddit API via an MCP server such as `Hawstein/mcp-server-reddit` | Needs an app key; respect rate limits |
| Bluesky | Public AppView API (`public.api.bsky.app`, no auth for search) or `gwbischof/bluesky-social-mcp` | Open, good for current debate |
| Mastodon / Fediverse | Instance REST API, or `JavaSpringVibes/social-mcp` | Per-instance search is limited |
| Hacker News | Algolia HN API | Free, no key |
| YouTube comments | YouTube Data API v3 | Key and quota required |
| Multi-platform listening | Syften MCP, Octolens | Paid; the widest coverage, including X |
| News coverage and tone | GDELT DOC 2.0 API | Free; volume and tone over time |
| Attention signals | Wikipedia pageviews API, Google Trends (unofficial) | For triangulation |
| Published polls | Wikipedia opinion-polling pages, national statistics offices | Grounds the claims |

X/Twitter and TikTok are the notable gaps. Their APIs are paid and restricted,
and scraping them is fragile and against their terms. The report should state
this, not paper over it.

## Implementation steps, in order

1. **MCP client in the backend.** Add `@modelcontextprotocol/sdk`. Read servers
   from an `MCP_SERVERS` JSON variable (`{name, url | command, args, env}`),
   connect at startup with `StreamableHTTPClientTransport` or
   `StdioClientTransport`, and map each server's `listTools()` into the
   OpenAI-style schema `TOOLS` already uses, prefixed `mcp__<server>__<tool>`.
   In `runToolCalls`, dispatch `mcp__*` names to `client.callTool`. This single change makes
   every source above pluggable without further code.
2. **Two built-in tools**, so the feature works with no MCP configured:
   `web_search` (Brave or SearXNG) and `read_url` (Jina Reader with plain-fetch
   fallback). Both are small, following the pattern of `fetch_statute`.
3. **Source store.** A `source_records` table in `localDb`, and a
   `save_source(url, platform, text, meta)` tool. It is deduplicated by URL and
   content hash, and author handles are hashed on write. The model may only
   quote text that exists in a stored record, the same "fetch before you cite"
   rule the case-law tools enforce.
4. **Study mode.** A study project type with a longer budget
   (`maxIterations` around 60, configurable), a system prompt holding the
   protocol above, and a `write_fieldnote` tool that saves a memo document. The
   agent runs rounds in the background and streams progress into the chat.
5. **Coding.** `export_to_review` turns source records into a tabular review
   with the codebook as columns. Add built-in column presets for stance, frame
   and emotion to `columnPresets.ts`.
6. **API.** Expose `POST /studies` and `GET /studies/:id` (status, rounds,
   records, report) so a study can run headless through the Space URL.

## Ethics and validity guardrails (build them in, don't leave them as advice)

- Only public content. Never log in as a user or join closed groups.
- Store pseudonymised handles. Don't quote identifiable private individuals
  verbatim in reports, or paraphrase instead.
- Honour robots.txt and API terms; rate-limit each host.
- Label the output as qualitative and non-representative. Always report which
  platforms were covered and which were missing.
- Flag likely bot or coordinated accounts (account age, posting cadence,
  duplicate text) instead of counting them as opinion.
- Keep the full sampling log so another researcher can replay the study.
