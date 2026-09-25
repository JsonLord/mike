# Research stack: llama inference for OpenResearcher and Dexter

Status: tested and planned on 2026-09-25. Nothing in the three Spaces has been
changed yet.

## The three Spaces

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

## Integration steps

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
