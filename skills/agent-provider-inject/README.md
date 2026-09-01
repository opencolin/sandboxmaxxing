# agent-provider-inject

Point coding-agent CLIs — **claude**, **codex**, **opencode** — at a custom inference
endpoint (Aisa, OpenRouter, Nebius Token Factory, opencode, or your own relay) by
injecting base URL, key and model.

Each CLI uses a different mechanism (env vars / TOML / JSON) **and a different wire
format**, and each has first-run gates that block headless runs. Get one wrong and it
fails in a way that blames the provider. This packages the working recipes.

## Install

As a Claude Code skill — user-level (available in every project):

```bash
git clone --depth 1 https://github.com/opencolin/tenki-deploy /tmp/tenki-deploy
mkdir -p ~/.claude/skills
cp -r /tmp/tenki-deploy/skills/agent-provider-inject ~/.claude/skills/
```

Or project-level: copy it to `.claude/skills/` in your repo.

Claude Code picks it up automatically; invoke with `/agent-provider-inject` or just
describe the task.

## Use the script directly (no Claude Code needed)

```bash
./scripts/inject-provider.sh \
  --base https://api.aisa.one \
  --key  "$PROVIDER_KEY" \
  --claude-model claude-sonnet-5 \
  --codex-model  gpt-5.3-codex \
  --workdir /path/to/project

. /path/to/project/.agent-provider.env   # then launch any agent
```

Writes `~/.claude.json`, `~/.codex/config.toml` + `auth.json`,
`<workdir>/opencode.json`, and an env file to source.
Flags: `--harness claude|codex|opencode|all`, `--codex-wire responses|chat`.

## Verified

Run from a clean sandbox against a live endpoint:

```
claude --dangerously-skip-permissions -p "Reply with exactly: OK"   → OK
codex exec --dangerously-bypass-approvals-and-sandbox "..."         → OK
```

## The traps it encodes

- `kimirelay` is **Nebius-shaped** — it reshapes requests, so any non-Nebius endpoint
  returns `400 … system.0: Input does not match the expected shape` even when plain
  curl to that endpoint works. Go direct instead.
- **Never set `ANTHROPIC_API_KEY`** — many images ship one, and any value makes claude
  stop at *"Detected a custom API key… use this API key?"*. `ANTHROPIC_AUTH_TOKEN`
  alone authenticates silently.
- **TOML root keys must precede every `[table]` header.** `model_provider`/`model`
  written after `[projects."…"]` silently become members of that table; codex ignores
  them and falls back to `api.openai.com`, then 401s with your key.
- **codex needs `auth.json`**, not just a provider `env_key`, or it stops at a sign-in
  menu — plus its own per-directory trust gate.
- **claude has two more headless gates** (`--dangerously-skip-permissions` covers
  neither): a theme picker and a per-folder trust dialog.
- **`codex` needs a TTY; `codex exec` does not** — plain `codex "prompt"` dies with
  `Error: stdin is not a terminal` in scripts and CI.
- **Reasoning models blow through proxy header timeouts.** A non-streaming request
  sends no headers until generation finishes; Kimi-K3 measured **149.9s** to first
  byte. An intermediate proxy kills it and the CLI reports an upstream `502` that is
  actually yours. Allow 300s+.
- Wire formats differ: claude → `/v1/messages`, codex → `/v1/responses`,
  opencode → `/v1/chat/completions`. If you proxy, allow the right paths.

See [SKILL.md](SKILL.md) for the full recipes, provider table and verification steps.

## Keeping keys out of the sandbox

Don't put a real key in a VM whose user is root. Run a relay: the sandbox holds a
scoped, revocable per-session token; the relay swaps in the real key server-side.
Point the CLIs at the relay URL exactly as documented — everything works unchanged,
and a leaked token is worthless elsewhere.
