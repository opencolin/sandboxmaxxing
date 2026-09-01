---
name: agent-provider-inject
description: Point coding-agent CLIs (claude, codex, opencode) at a custom inference endpoint — Aisa, OpenRouter, Nebius Token Factory, opencode, or your own relay — by injecting base URL, key and model. Use when configuring agents in sandboxes/containers/CI to use a non-default provider, when an agent ignores your base URL, or when it stalls on a first-run prompt, sign-in gate, or 400/401/502 against a custom endpoint.
---

# Inject an inference provider into agent CLIs

Redirect `claude`, `codex` and `opencode` to any OpenAI/Anthropic-compatible endpoint.
Each CLI takes a **different mechanism** (env vars / TOML / JSON) and a **different wire
format**. Getting one wrong fails in a way that blames the provider, so read the gotchas.

`scripts/inject-provider.sh` does all three non-interactively. Read it before running it
in an environment you care about.

## Decide two things first

**1. Wire format the endpoint serves.** This drives everything:

| Format | Path | Native harness |
|---|---|---|
| Anthropic Messages | `POST /v1/messages` | `claude` |
| OpenAI Responses | `POST /v1/responses` | `codex` (v0.144+) |
| OpenAI Chat Completions | `POST /v1/chat/completions` | `opencode`, older codex |

Verify before configuring anything — one curl saves an hour:

```bash
BASE=https://api.example.com KEY=sk-...
curl -s -o /dev/null -w "messages:%{http_code}\n"    $BASE/v1/messages    -H "authorization: Bearer $KEY" -H 'content-type: application/json' -H 'anthropic-version: 2023-06-01' -d '{"model":"M","max_tokens":16,"messages":[{"role":"user","content":"hi"}]}'
curl -s -o /dev/null -w "responses:%{http_code}\n"   $BASE/v1/responses   -H "authorization: Bearer $KEY" -H 'content-type: application/json' -d '{"model":"M","input":"hi"}'
curl -s -o /dev/null -w "chat:%{http_code}\n"        $BASE/v1/chat/completions -H "authorization: Bearer $KEY" -H 'content-type: application/json' -d '{"model":"M","max_tokens":16,"messages":[{"role":"user","content":"hi"}]}'
```

**2. Whether a wrapper is involved.** `kimirelay` is built for Nebius Token Factory and
**reshapes requests into a Nebius-specific form**. Pointing it at a non-Nebius endpoint
yields `400 … system.0: Input does not match the expected shape` even though plain curl to
that endpoint works. Use it only for Nebius; go direct otherwise.

## claude (Claude Code)

```bash
export ANTHROPIC_BASE_URL='https://api.example.com'   # ORIGIN only — it appends /v1/messages
export ANTHROPIC_AUTH_TOKEN='<key>'
unset  ANTHROPIC_API_KEY                              # see gotcha 2 — this is mandatory
export ANTHROPIC_MODEL='<model-id>'
exec claude --dangerously-skip-permissions "$(cat prompt.txt)"
```

Requires an endpoint serving the **Anthropic** format. Headless also needs onboarding
pre-seeded in `~/.claude.json` (gotcha 3).

## codex

`~/.codex/config.toml` — **root keys must precede every `[table]` header** (gotcha 4):

```toml
model_provider = "relay"
model = "<model-id>"

[model_providers.relay]
name = "relay"
base_url = "https://api.example.com/v1"    # INCLUDES /v1
env_key = "OPENAI_API_KEY"
wire_api = "responses"                      # or "chat"

[projects."/path/to/workdir"]
trust_level = "trusted"
```

Plus auth, or it stops at a sign-in menu (gotcha 5):

```bash
export OPENAI_API_KEY='<key>'
mkdir -p ~/.codex && printf '%s' '{"OPENAI_API_KEY":"<key>"}' > ~/.codex/auth.json
exec codex --dangerously-bypass-approvals-and-sandbox "$(cat prompt.txt)"
```

## opencode

`opencode.json` in the working directory:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "provider": {
    "relay": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "relay",
      "options": { "baseURL": "https://api.example.com/v1", "apiKey": "<key>" },
      "models": { "<model-id>": {} }
    }
  }
}
```

Run with `opencode --auto --model relay/<model-id> --prompt "..."`. Note opencode also
serves **keyless free models** (`opencode/<name>-free`) needing no provider at all — the
cheapest way to smoke-test a harness.

## Providers

| Provider | Base URL | Auth header | Serves |
|---|---|---|---|
| Aisa | `https://api.aisa.one` | `Authorization: Bearer` | messages + responses + chat (100+ models) |
| OpenRouter | `https://openrouter.ai/api` | `Authorization: Bearer` | chat (`:free` tier exists) |
| Nebius Token Factory | `https://api.tokenfactory.nebius.com` | `Authorization: Bearer` | chat |
| opencode native | — | none | its own free models |
| TinyFish (search, not inference) | `api.search.tinyfish.ai` | **`X-API-Key`** | free tier, key still required |

Not every provider uses Bearer — check before assuming.

## Gotchas (each cost real debugging time)

1. **kimirelay is Nebius-shaped.** See above. Bypass it for anything but Nebius.
2. **Never set `ANTHROPIC_API_KEY` for claude.** Many images ship one; any value triggers a
   blocking *"Detected a custom API key in your environment … use this API key?"* prompt.
   `ANTHROPIC_AUTH_TOKEN` alone authenticates silently.
3. **claude has two more headless gates** `--dangerously-skip-permissions` does not cover:
   the theme picker and a per-folder trust dialog. Pre-seed `~/.claude.json`:
   `{"hasCompletedOnboarding":true,"theme":"dark","bypassPermissionsModeAccepted":true,
   "projects":{"<cwd>":{"hasTrustDialogAccepted":true,"projectOnboardingSeenCount":1,"allowedTools":[]}}}`
   Without `projects[cwd].hasTrustDialogAccepted` it waits forever for a keypress.
4. **TOML root keys must come before any `[table]` header.** `model_provider`/`model` placed
   after `[projects."…"]` silently become members of *that table*; codex ignores them and
   falls back to `api.openai.com`, then 401s with your key. Symptom: the banner shows a
   model you never configured.
5. **codex needs `auth.json` too.** A provider `env_key` alone is not enough — it stops at
   *"Sign in with ChatGPT / provide an API key"*. Name the provider's `env_key`
   `OPENAI_API_KEY` and write `auth.json` with the same value.
6. **codex also has its own trust gate** (`[projects."…"] trust_level = "trusted"`), not
   covered by `--dangerously-bypass-approvals-and-sandbox`.
7. **Reasoning models blow through proxy header timeouts.** A NON-streaming request sends no
   headers until generation completes; a reasoning model can exceed 60s easily (Kimi-K3
   measured **149.9s** time-to-first-byte for 8000 tokens). A proxy in between then kills it
   and the CLI reports an upstream `502 bad gateway` that is actually *yours*. Allow 300s+.
8. **Reasoning models need output headroom.** A small `max_tokens` returns EMPTY content with
   `finish_reason:"length"` because thinking consumed the budget. Don't conclude "broken".
9. **Proxying? allow the right paths.** codex needs `responses`, claude needs `messages`,
   opencode needs `chat/completions`. A missing path 403s and surfaces as
   `stream disconnected before completion: response.failed`.

## Keeping keys out of the sandbox (recommended)

Don't put a real key in a VM someone else can read. Run a small relay: the sandbox gets a
scoped, revocable per-session token; the relay swaps in the real key server-side and
forwards. Point the CLIs at the relay URL exactly as above — everything works unchanged,
and a leaked token is worthless elsewhere. Fail closed: if the relay lacks a key, the route
should 404 rather than pass the token upstream.

## Verify

Never declare success on config alone — run the agent. These exact invocations are
verified working against Aisa from a clean sandbox:

```bash
claude --dangerously-skip-permissions -p "Reply with exactly: OK"
codex exec --dangerously-bypass-approvals-and-sandbox "Reply with exactly: OK"
opencode --auto --model relay/<model> --prompt "Reply with exactly: OK"
```

**`codex` needs a TTY; `codex exec` does not.** Plain `codex "prompt"` dies with
`Error: stdin is not a terminal` in a script, CI job or `sandbox exec`. Either use
`codex exec` for one-shot headless runs, or run the TUI under a pty:
`tmux new-session -d -s agent 'codex --dangerously-bypass-approvals-and-sandbox "..."'`
(the TUI is what you want if a human should be able to attach and steer it later).

**Benign:** `warning: Model metadata for '<model>' not found. Defaulting to fallback
metadata` just means codex has no built-in profile for a model served via a custom
provider. It still works — do not chase it.

If it stalls, capture the screen rather than guessing — in tmux:
`tmux capture-pane -pt <session> | tail -20`. Nearly every failure here is a visible
interactive prompt, not a network error.
