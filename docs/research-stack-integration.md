# Research stack: llama inference for OpenResearcher and Dexter

Status: **deployed and tested on 2026-09-25.** The "Deployed" section below
records what changed in each Space and how it was verified. The measurements
and the original plan follow it.

## Deployed

| Space | Change | Commit |
|---|---|---|
| `Leon4gr45/llama` | Secret `API_KEY` set, so `/v1` now rejects requests without the key (401). The gateway defaults `chat_template_kwargs.enable_thinking=false`; callers can still turn it on. | [eac299b](https://huggingface.co/spaces/Leon4gr45/llama/commit/eac299baab9213151294226b2fce5d4cd14659ea) |
| `Leon4gr45/openresearcher` | Inference goes to the llama Space (`OPENAI_*`, default mode "Cloud only", `MAX_NEW_TOKENS=1024`). Search tries SearXNG (`SEARXNG_BASE_URL`) first, with a relevance guard, then Jina. Other fixes: `n_ctx` is read from llama.cpp's `meta`; numeric-string link ids are accepted; GLM-style `<arg_key>` text tool calls are parsed; a final answer is forced when the round limit is hit; `mcp` is pinned `<2` (2.x removed `streamablehttp_client`, which would crash the next rebuild). New JSON API `research(question, max_rounds)`. | [f8d3fe9](https://huggingface.co/spaces/Leon4gr45/openresearcher/commit/f8d3fe9aa6aee610b7d050ac1cd77b5e372aa47e) |
| `Leon4gr45/dexter` | `DEXTER_DEFAULT_MODEL=auto`, `DEXTER_FALLBACK_MODELS=auto,llama:spark-x2.5-1.7b`. Keyless `web_search` provider (SearXNG, then Jina MCP). New `openresearcher_deep_search` tool, also available to `research` subagents. New `llama:` provider with thinking off. New `public-opinion-study` skill. Empty replies are retried. **Root cause of the empty answers:** streamed tool calls from the gateway were not reassembled, so the reply is now re-requested without streaming. SSE keep-alive added (Bun's 255 s idle timeout was cutting slow runs). | [12c4c6c](https://huggingface.co/spaces/Leon4gr45/dexter/commit/12c4c6ce85a9f8e473cfe42f704eeff695b7c5ab), [7e5fa12](https://huggingface.co/spaces/Leon4gr45/dexter/commit/7e5fa126ef3dd235252d08ec02f2135291159f33) |

### Hybrid model split (follow-up)

- **Dexter (orchestrator):** `auto` from freellmapi only.
  `DEXTER_FALLBACK_MODELS=auto`, so it never falls back to the 1.7B model.
  `DEXTER_FAST_MODEL=auto`, because the built-in `gpt-5.4-mini` is not in
  freellmapi's catalog, so every `web_fetch` failed with a 400.
- **OpenResearcher (research jobs):** the llama Space (`spark-x2.5-1.7b`).
- **Headless runs:** `/v1/query` sets `autoContinue`. When a reply without
  tool calls only announces a plan or asks how to proceed, the agent is told
  to continue (at most twice). The `auto` router produced both kinds of
  reply in testing.

Commits: [3fe7bec](https://huggingface.co/spaces/Leon4gr45/dexter/commit/3fe7bec18c883e6e05fcdb2b12bbc67c52e8442b),
[d51c262](https://huggingface.co/spaces/Leon4gr45/dexter/commit/d51c2624aa0aded886ab1c8359e78865cad96447),
[9fbcb19](https://huggingface.co/spaces/Leon4gr45/dexter/commit/9fbcb1938f5b013ea924a07aea1da1574ffad855).

Full-pipeline test (one-round study, one OpenResearcher job with
`max_rounds` 6):

| Run | Outcome |
|---|---|
| 1 | Tools ran (web_search, skill, OpenResearcher 18 min), 14 sources, but the final message asked "how would you like to proceed?" |
| 2 | Ended after 2 s with a narrated plan and no tool calls |
| 3 (autoContinue) | Complete: skill, memory, web_search, OpenResearcher (28 min), browser, web_fetch; report with 38 sources (r/de, Spiegel, FAZ, Tagesschau, ZDF, DLF, YouTube). The report noted "tooling errors": `web_fetch` was failing on `gpt-5.4-mini`. |
| 4 | Stream closed at 259 s, during the OpenResearcher job, with no answer. The Space logs show nothing at that moment: no restart (the only one was at 00:07:41, before the run), no process exit, no proxy error. Most likely the connection dropped between client and Space. Did not recur in run 5. |
| 5 (all fixes) | **Complete in 14.5 min, no errors:** skill, web_search, one OpenResearcher job (13 min on llama), memory update, report in the skill's six sections, 11 citations. The report is honest but **thin**: its findings rest on one English-language Reddit thread (r/LinusTechTips), because the prompt limited it to one round and one sub-question, and the 1.7B deep search surfaced little. It listed three more Reddit threads as "identified but not opened". |

Improvements for real studies:
- Run 3–6 rounds, not one. The skill's saturation check needs several.
- Let Dexter `web_fetch` the threads OpenResearcher only lists (this works
  now) instead of relying on its summary.
- For key sub-questions, consider pointing OpenResearcher at `auto` instead
  of llama. It would be faster and better, but no longer free.

### Validation round (2026-09-26): Deutschlandticket study

A new topic, to check the workflow is not tuned to the heat-pump example.
Each attempt exposed a defect, fixed before the next:

| Attempt | Outcome | Fix |
|---|---|---|
| 1 (`depth: deep`) | Hit the 20-step limit; answer was only "Reached maximum iterations". Several `web_fetch`/`browser` calls "finished" instantly | `depth: "study"` = 60 steps; at any step limit Dexter writes the best answer from what it gathered; tool errors inside results are now reported as WARNING events |
| (diagnosis) | The warnings showed Reddit answering `web_fetch` with 403; `browser` and Jina `read_url` get the "Prove your humanity" wall; PullPush refuses agents (429) | New keyless **`reddit_search`** tool via the Arctic Shift archive (posts by title, top comments of a thread, keyword comment search; no usernames). OpenResearcher's `open` reads Reddit threads the same way. The archive rate-limits hard (422 "Timeout. Maybe slow down a bit"), so the tool paces requests 3 s apart and backs off 10/30/60 s |
| 2 | Stopped after 21 s with only the "Round 0: Scope" text: the phrase-matching guard missed it | Headless runs now end only on an explicit `[[FINAL]]` marker (stripped from the answer); a reply without tools and without it gets "continue" (max 3) |
| 3 | **Complete in 25 min:** 11 `reddit_search` calls, web search and fetch, one OpenResearcher job (14 min), fieldnotes in memory; report with 5 themes and 19 quotes | See validation below |

Validation of attempt 3 with `dexter/scripts/validate-report.ts`:

- **URLs:** 16 in the report, all 16 returned by tools (none invented), all
  16 reachable.
- **Quotes:** 15 of 19 found verbatim at the exact URL cited, mostly
  comment-level Reddit permalinks. 2 were real ZDF statements wrapped in the
  report's own framing ("beschrieb … als"); 1 real comment had "Man kann"
  changed to "Ich kann"; 1 (SWR) had no URL, which the report disclosed.
  **No fabricated quotes.**
- **Unsourced claims:** the stance percentages (60/25/15 %), a poll
  comparison ("Infratest dimap, YouGov…") and a ridership claim had no
  opened source behind them.
- **Fix:** the skill now requires character-exact quotes, stance as counts
  of coded sources, and a source URL for every poll or statistic
  ([c4f8c95](https://huggingface.co/spaces/Leon4gr45/dexter/commit/c4f8c959937da6a9e9039b4f02232ff1cf32fb7e)).

Confirmation run with the stricter skill (64 min: 6 `reddit_search`,
7 `web_fetch`, 4 `web_search`, 2 OpenResearcher jobs):

- **Stance** is now a table of coded-source counts (5 against, 3 mixed,
  0 for), not invented percentages.
- **Poll claim** now cites an opened Infratest dimap page. Its figures
  (16 % own, 40 % could imagine, 42 % reject) match the page exactly, but the
  stated field period "July–Aug 2023" does not appear on it.
- **URLs:** 9, all from tools, all reachable.
- **Quotes:** 6 of 7 verbatim at the cited URL (Reddit comments and post
  bodies, a Bluesky post). One ("Ein Deutschlandticket kostet 63,00 €…") is
  misattributed: the cited Spiegel Bluesky post is about something else, so
  the text likely came from a search snippet.
- The report is more cautious: 8 coded sources compared with 19 quotes
  before. One `reddit_search` still failed on the archive's rate limit after
  all retries, and was reported as a warning.
- **Fix:** the skill now forbids quoting or taking dates and figures from
  `web_search` snippets; only text a tool returned for the opened page counts
  ([Dexter Space commits](https://huggingface.co/spaces/Leon4gr45/dexter/commits/main)).
  The validator now also reads Reddit post titles and bodies and skips
  logged search queries.

**Tiers:** OpenResearcher's research API takes `tier` (`small` = llama,
`auto` = the `AUTO_BASE_URL`/`AUTO_MODEL`/`AUTO_API_KEY` backend). Dexter's
tool and skill use `auto` only for the sub-questions the findings depend on.
`AUTO_*` is **not configured yet**: the freellmapi URL and key are Dexter
secrets and cannot be read back, so `auto` jobs currently fall back to
`small`. The result's `tier` field reports which model actually ran.

Verified live:

- llama: `/v1/models` returns 401 without the key and 200 with it. A plain
  request with no extra fields answers in 4.6 s without reasoning.
- OpenResearcher: `/gradio_api/call/research` returns
  `{answer, sources, rounds, status, error}`. A 6-round job cited a real
  Reddit thread and listed four Reddit threads as sources (886 s while it
  shared the llama slot with another job).
- Dexter: the question that returned an empty answer three times now runs
  `web_search`, returns citations and a full answer in 12 s.

Using it:

```bash
# Dexter (orchestrator); the skill triggers on public-opinion questions
curl -N -X POST https://leon4gr45-dexter.hf.space/dexter-api/v1/query \
  -H 'Content-Type: application/json' \
  -d '{"messages":[{"role":"human","content":"Run a public opinion study on ..."}],"depth":"deep"}'

# OpenResearcher (one deep-search job)
curl -X POST https://leon4gr45-openresearcher.hf.space/gradio_api/call/research \
  -H 'Content-Type: application/json' -d '{"data":["<question>", 20]}'
# -> {"event_id": "..."}; then GET .../gradio_api/call/research/<event_id> (SSE)
```

Known limits:

- **SearXNG** (`cjj-on-hf-searxng.hf.space`) currently yields nothing
  usable: Brave is rate-limited, DuckDuckGo and Startpage show CAPTCHAs, and
  Bing returns results unrelated to the query. Every search therefore falls
  back to Jina today. It switches over automatically once the instance
  returns relevant results. `SEARXNG_ENGINES` can restrict the engine list.
- **Reddit** often answers direct fetches with "Prove your humanity". Jina
  `read_url` gets through more often.
- **llama** has one slot: concurrent jobs queue. A 1.7B model gives thin
  answers, so keep it for workers and let Dexter's `auto` model lead.
- `/dexter-api/v1/query` has no authentication, and every call spends the
  freellmapi key. An automated scanner probed the Space on 2026-09-26
  (`/.env`, `/.streamlit/secrets.toml`, `/file=../.env`, `/openapi.json`).
  All returned 404 except `openapi.json`. Consider a shared-secret check on
  `/dexter-api/*` in the FastAPI proxy.
- An OpenResearcher job with `max_rounds` 6 takes 18–28 minutes on the CPU
  model. Studies with several deep-search jobs run for hours, and parallel
  jobs queue behind the single llama slot.

## The three Spaces (before the changes)

| Space | Role | State when tested |
|---|---|---|
| `Leon4gr45/llama` | llama.cpp server (`spark-x2.5-1.7b`, Q8, 32k context) behind a FastAPI gateway | Running on cpu-basic |
| `Leon4gr45/openresearcher` | Gradio deep-search agent: search, open and find over the Jina MCP server; stops when its goal is met | Running, but **no answers**: its local model needs a GPU (the Space is on cpu-basic) and the cloud fallback returns a non-JSON body (`Expecting value`), so `OPENAI_BASE_URL` is wrong or missing |
| `Leon4gr45/dexter` | TypeScript agent with parallel subagents, cron, memory, web search and fetch, Lightpanda browser, skills, and an SSE `POST /dexter-api/v1/query` | Running. The default model fails (`mistral-large-3-675b is not in the catalog`). With `model: "auto"` a trivial prompt works, but research prompts return an **empty answer with no tool calls** |

## llama Space: measured

The endpoint is **`https://leon4gr45-llama.hf.space/v1`**, not `/api`.

- `/v1/*` goes through the gateway, which **does not check a key** because its
  `API_KEY` is unset. The gateway then adds the llama.cpp key itself.
- `/api/*` and other unknown paths fall through to llama.cpp, which checks
  `sk-gemini` and then returns 404. So `sk-gemini` is the llama.cpp key.

| Test | Result |
|---|---|
| Short answer, thinking on (default) | 600 tokens of reasoning, **no answer**, 67 s |
| Short answer, `chat_template_kwargs.enable_thinking=false` | Correct, 23 tokens, **3 s** |
| Tool call (`web_search` schema), thinking off | Correct `tool_calls`, valid JSON arguments, **9 s** |
| 2,000-token prompt with a tool result, thinking off | Sensible coding summary, **69 s** (prefill about 36 tok/s) |
| Generation speed | About 9–10 tok/s |
| 3 concurrent short requests | 1.2 / 2.3 / 1.9 s, serialized |

What this means:

1. **Thinking must be off for agent use.** Every caller has to send
   `"chat_template_kwargs": {"enable_thinking": false}`, or the gateway should
   inject it by default. Otherwise the reasoning uses up `max_tokens` and the
   answer is empty.
2. **Tool calling works.** llama.cpp build b11118 ships a tool-aware chat
   template, and the model emits well-formed OpenAI `tool_calls`.
3. **Prefill is the bottleneck.** An agent loop re-sends its system prompt,
   tool schemas and history on every step. llama.cpp's prompt cache reuses the
   shared prefix, but only for one conversation at a time (`--parallel 1`, plus
   a gateway-wide lock). Parallel subagents evict each other's cache, and each
   switch costs a full prefill of about 30 s per 1,000 tokens.
4. **A 1.7B model is a worker, not a planner.** It can classify, extract,
   summarise a page, and choose the next search. It should not orchestrate a
   multi-day study or write the final synthesis.
5. **Security:** set `API_KEY=sk-gemini` (or a new secret) on the llama Space.
   Right now anyone can use `/v1` without a key.

## Proposed division of labour

```
            ┌──────────── Dexter (orchestrator, big model via freellmapi "auto") ─────────────┐
 study ───▶ │ plans rounds · cron schedules them · memory holds the field map and codebook   │
            │ spawn_subagent ─┬─ OpenResearcher job (deep search on one sub-question)         │
            │                 ├─ platform subagents (Reddit / Bluesky / HN / news)            │
            │                 └─ coding worker ──▶ llama /v1 (stance, frame, quote extract)   │
            └───────────────────────────────▶ source records + fieldnotes ─▶ Mike tabular review
```

- **Dexter** is the right orchestrator. It already has subagents that run in
  parallel, cron for repeated rounds, persistent memory backed up to Git, a
  skills system (`x-research/SKILL.md` is a working template for a social
  listening skill), and an SSE API. It should keep a strong model for planning.
- **OpenResearcher** fits as a long-running deep-search worker: one
  sub-question per job, up to 200 rounds, and it stops when its goal is met. It
  is a Gradio app, so a caller uses `gradio_client`'s
  `/start_research(question, serper_key, max_rounds, inference_mode)`. The
  output is HTML and needs stripping.
- **llama** handles cheap bulk work: coding thousands of posts, extracting
  quotes, and summarising pages for OpenResearcher, with no API cost.

## Integration steps (original plan, now done except where noted)

### llama Space
1. Set the secret `API_KEY` so `/v1` requires a key.
2. In `gateway.py` `ensure_language_guard`, default `chat_template_kwargs` to
   `{"enable_thinking": false}` when the caller doesn't set it.
3. Optional: `--parallel 2` with `--ctx-size 65536` (32k per slot) so two
   agents don't evict each other's cache. Prefill is CPU-bound either way.

### OpenResearcher
1. Secrets: `OPENAI_BASE_URL=https://leon4gr45-llama.hf.space/v1`,
   `OPENAI_MODEL=spark-x2.5-1.7b`, `OPENAI_API_KEY=<llama key>`, and
   `MAX_CONTEXT_TOKENS=28000`. Its `/models` detection reads top-level
   `n_ctx`, but llama.cpp puts it under `meta.n_ctx`, so it would otherwise
   assume 100k and overflow.
2. In `_generate_cloud`, add `"chat_template_kwargs": {"enable_thinking": False}`
   to the payload (or read it from an env var). Skip this if the gateway change
   above is made.
3. Make "Cloud only" the default inference mode. The Space has no GPU, so
   "Auto" wastes a failed local attempt every round.
4. Lower `MAX_NEW_TOKENS` from 4096 to about 1024. At about 10 tok/s, 4096
   tokens is 7 minutes per round.
5. Expose a plain-JSON endpoint, e.g. `gr.api` returning
   `{answer, sources[]}`, so Dexter doesn't have to parse HTML.

### Dexter
1. Fix `DEXTER_DEFAULT_MODEL`. The error names `mistral-large-3-675b`, which
   freellmapi doesn't serve. Use `auto`, or a model from its `/v1/models`.
2. Look into the empty answers with `auto`: no tool calls were emitted at all.
   Likely causes are the OpenAI provider's `fastModel: gpt-5.4-mini` (not on
   freellmapi) or no `web_search` provider key (`EXASEARCH_API_KEY` /
   `TAVILY_API_KEY` …) being set, which removes `web_search` from the tool
   list.
3. Add a `llama` provider in `src/providers.ts` and `src/model/llm.ts`:
   prefix `llama:`, `ChatOpenAI` with `baseURL=LLAMA_BASE_URL`,
   `apiKey=LLAMA_API_KEY`,
   `modelKwargs: { chat_template_kwargs: { enable_thinking: false } }`, and
   `contextWindow: 32768`. Then subagents or skills can request
   `llama:spark-x2.5-1.7b` while the leader keeps the strong model.
4. Add tools:
   - `openresearcher_deep_search(question, max_rounds)`: calls the Gradio API,
     returns answer and sources.
   - Mike's `POST /api/chat` and tabular review endpoints, for coding and
     storing results (see `docs/api-access.md`).
   - Social sources (Reddit, Bluesky, HN, GDELT), as described in
     `docs/public-opinion-ethnography.md`.
5. Add a `public-opinion-study` skill (`SKILL.md`) that encodes the
   round-based protocol: field map, explore, fieldnotes, code, triangulate,
   saturation check, report. Model it on `x-research`.
