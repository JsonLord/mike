# OpenAI-compatible provider

The backend can route every OpenAI-family request to any endpoint that speaks
the OpenAI chat-completions API (vLLM, Together, Groq, OpenRouter, a local
proxy, …). It is configured entirely through environment variables — on the
Hugging Face Space these are the Space *Settings → Secrets*.

| Variable | Required | Example |
| --- | --- | --- |
| `OPENAI_COMPATIBLE_URL` | yes | `https://api.groq.com/openai/v1` |
| `OPENAI_COMPATIBLE_MODEL` | yes | `llama-3.3-70b-versatile` |
| `OPENAI_COMPATIBLE_API` | yes | the endpoint's API key |

`OPENAI_COMPATIBLE_URL` may be given as a base url (`…/v1`) or as the full
`…/v1/chat/completions` path; the missing suffix is appended automatically.

## What happens when all three are set

* The OpenAI provider is marked **configured by the server** — users cannot
  overwrite it from *Account → Models*, and the key is never sent to the browser.
* `GET /config` (public, no auth) advertises the configured model:

  ```json
  {
    "openaiCompatible": { "enabled": true, "model": "llama-3.3-70b-versatile" },
    "models": [{ "id": "llama-3.3-70b-versatile", "label": "…", "group": "OpenAI" }]
  }
  ```

  The frontend merges those into the model picker, so the configured model is
  selectable in chat and as the tabular-review model, and becomes the default
  selection for users who have not picked one.
* Every OpenAI request is **pinned** to `OPENAI_COMPATIBLE_MODEL`. A custom
  endpoint only serves the model it was configured with, so a stale selection
  such as `gpt-5.5` is rewritten rather than sent through and rejected.
* Server-side defaults (main chat, chat-title generation, tabular review) fall
  back to the configured model instead of the built-in OpenAI ids.

Leaving any of the three unset keeps the previous behaviour: requests go to
`https://api.openai.com/v1/chat/completions` with `OPENAI_API_KEY`, or to the
per-user key saved in *Account → Models*.
