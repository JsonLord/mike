#!/usr/bin/env bash
# Smoke-test the public API of a deployment (default: the Hugging Face Space).
#   scripts/smoke-test-api.sh [BASE_URL] [--no-chat]
# --no-chat skips the inference call, which creates a chat and spends tokens.
set -u
BASE="${1:-https://leon4gr45-scriber.hf.space}"
BASE="${BASE%/}"
RUN_CHAT=1
for arg in "$@"; do [ "$arg" = "--no-chat" ] && RUN_CHAT=0; done

fail=0
check() { # method path expected_status
  local code
  code=$(curl -sS -m 30 -o /dev/null -w "%{http_code}" -X "$1" "$BASE$2")
  if [ "$code" = "$3" ]; then echo "ok   $1 $2 -> $code"; else echo "FAIL $1 $2 -> $code (want $3)"; fail=1; fi
}

check GET /health 200
check GET /api-docs 200
check GET /api/health 200
check GET /api/config 200
check GET /api/chat 200
check GET /api/projects 200
check GET /api/single-documents 200
check GET /api/tabular-review 200
check GET /api/workflows 200
check GET /api/user/profile 200

if [ "$RUN_CHAT" = 1 ]; then
  out=$(curl -sS -N -m 180 -X POST "$BASE/api/chat" -H 'Content-Type: application/json' \
    -d '{"messages":[{"role":"user","content":"Reply with exactly: API OK"}]}')
  if printf '%s' "$out" | grep -q '"type":"content_delta"' && printf '%s' "$out" | grep -q '\[DONE\]'; then
    echo "ok   POST /api/chat -> streamed answer"
  else
    echo "FAIL POST /api/chat"; printf '%s\n' "$out" | head -20; fail=1
  fi
fi

exit $fail
