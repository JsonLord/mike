# API access

The Space at <https://leon4gr45-scriber.hf.space> serves the backend API
alongside the web app. nginx routes `/api/*` to the Express backend and strips
the prefix, so `POST /api/chat` reaches the backend's `POST /chat`. `/health`
and `/api-docs` are also served without the prefix.

`GET /api-docs` returns the list of endpoints as JSON.

## Authentication

None. `requireAuth` assigns every request to a single built-in local user, so
anyone who knows the URL can read the data and run inference on the
configured model key. Two ways to lock it down:

- make the Space private (then HF requires `Authorization: Bearer <HF token>`),
  or
- add a shared-secret check in `backend/src/middleware/auth.ts`. The web UI
  calls the same `/api` paths from the browser, so it would have to send the
  secret too.

## Examples

```bash
BASE=https://leon4gr45-scriber.hf.space

# Which models the `model` field accepts
curl -s $BASE/api/config

# One chat turn. The response is Server-Sent Events: `data: {json}` lines,
# ending with `data: [DONE]`.
curl -sN -X POST $BASE/api/chat -H 'Content-Type: application/json' \
  -d '{"messages":[{"role":"user","content":"Summarise § 823 BGB"}]}'

# Continue that chat: pass the chat_id from the first `chat_id` event
curl -sN -X POST $BASE/api/chat -H 'Content-Type: application/json' \
  -d '{"chat_id":"<id>","messages":[{"role":"user","content":"And § 826?"}]}'

# Upload a document (pdf, docx, doc)
curl -s -X POST $BASE/api/single-documents -F file=@contract.pdf
```

To get the plain answer text from the stream, join the `text` fields of the
`content_delta` events:

```python
import json, requests

r = requests.post(f"{BASE}/api/chat", stream=True,
                  json={"messages": [{"role": "user", "content": "Hello"}]})
answer = []
for line in r.iter_lines(decode_unicode=True):
    if not line or not line.startswith("data: ") or line == "data: [DONE]":
        continue
    event = json.loads(line[6:])
    if event["type"] == "content_delta":
        answer.append(event["text"])
print("".join(answer))
```

## Limits

Rate limits are applied per IP (see `backend/src/index.ts`). The defaults are
300 requests per 15 min overall and 30 chat turns per 15 min. They can be
changed with the `RATE_LIMIT_*` variables.

## Smoke test

```bash
scripts/smoke-test-api.sh                    # against the Space
scripts/smoke-test-api.sh http://localhost:7860 --no-chat
```
