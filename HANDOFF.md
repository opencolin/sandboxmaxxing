# sandboxmaxxing — handoff

_Last verified: 2026-10-08._

Competing teams of AI coding agents, each in its own disposable Tenki microVM. One prompt
fans out to a team (or two rival teams); you watch any agent's terminal live, type to it
mid-run, pick the better build, and every team iterates on it.

## Live now

| | |
|---|---|
| **Stable URL** | https://sandboxmaxxing--swc27h.us.sb.tenki.sh ✅ serving |
| **Domain** | https://sandboxmaxxing.com ⚠️ **404 — needs one change, see Blockers** |
| **Host sandbox** | `01a11f62-ab7e-7184-91d0-918132ceb804` (`tenki-redesign-host`, sticky, 2c/2048M) |
| **Sticky preview URL** | id `01a11f62-ac2c-74d6-8527-b6b24e6076e1`, slug `sandboxmaxxing` |
| **Workspace suffix** | `swc27h` (was `irtbn5` — it changed, which is why the domain broke) |
| **Repo** | https://github.com/opencolin/sandboxmaxxing |

## What works vs. what's dark

**Working:** the site, the arena UI, `/api/maxx`, minting demo sandboxes, the opencode
harness (keyless free models), theater view, pick-a-winner rounds, writable terminals + `/say`.

**Dark — needs API keys that were lost with the old host disk:**

| Key | Unlocks |
|---|---|
| `AISA_API_KEY` | Default provider. **claude + codex harnesses** (`api.aisa.one`) |
| `OPENROUTER_API_KEY` | OpenRouter provider + the arena judge |
| `NEBIUS_API_KEY` | Nebius/Kimi-K3 provider + opencode Frontier mode. Must be a **Token Factory API key**, not an IAM token (`v1.CmQK…` style IAM tokens 401) |
| `TINYFISH_API_KEY` | Agent web search (free tier, but a key is still required) |

Everything degrades closed — missing key means the route 404s and the feature is absent,
not broken. Add them to `/home/tenki/broker/.env` on the host and restart the service.

## Blockers / decisions needed

1. **Domain is 404.** The Vercel project `sandboxmaxxing` (`prj_040XXuVRiTDS4BhgZ96ZDYbarAPx`,
   team `dablclub`) proxies to the *old* workspace. Fix is one line — redeploy its
   `vercel.json` with `swc27h` in place of `irtbn5`:
   ```json
   { "rewrites": [
     { "source": "/",       "destination": "https://sandboxmaxxing--swc27h.us.sb.tenki.sh/" },
     { "source": "/:path*", "destination": "https://sandboxmaxxing--swc27h.us.sb.tenki.sh/:path*" } ]}
   ```
   Both rules are required — `/:path*` alone does not match the bare root. The project must
   contain **only** `vercel.json` (no `index.html`), or the static file wins over the rewrite.
   *Could not apply on 2026-10-08: the `deploy_to_vercel` MCP tool errors with "not found"
   while other Vercel tools work. Use the Vercel dashboard or CLI.*
2. **The host keeps dying** — four times now. Once was workspace balance; the others are
   unexplained. Treat rebuild as routine (~3 min, below) and consider automating it.
3. **Open product question: BYOC?** Does Tenki plan bring-your-own-cloud (sandboxes in the
   customer's VPC)? This decides the positioning — see `SANDBOX-VS-WORKTREE.md`.

## Rebuild runbook (the thing you will actually need)

The host dies periodically and the session scratchpad is wiped between sessions, so this is
the source of truth. ~3 minutes.

```bash
# 1. host
tenki sandbox create --name tenki-redesign-host --cpu 2 --memory-mb 2048 --sticky \
  --allow-inbound --allow-outbound --pause-retention 720h --no-wait

# 2. stable URL — REUSE the existing one if it still exists (preview-url list).
#    If it is gone, create it; the workspace suffix may change, which breaks the domain.
tenki sandbox preview-url create --slug sandboxmaxxing

# 3. push (retry each — writes flake with transient 502s)
tenki sandbox exec --session $HOST -- bash -lc 'mkdir -p /home/tenki/site /home/tenki/broker/{teams,seat}'
tenki sandbox write --session $HOST --path /home/tenki/site/index.html      --data-file index.html
tenki sandbox write --session $HOST --path /home/tenki/broker/broker.js     --data-file broker/broker.js
tenki sandbox write --session $HOST --path /home/tenki/broker/maxx.js       --data-file broker/maxx.js
tenki sandbox write --session $HOST --path /home/tenki/broker/package.json  --data-file broker/package.json
# + broker/teams/*.json, broker/seat/websearch-mcp.js, and .env

# 4. deps + service
tenki sandbox exec --session $HOST -- bash -lc 'cd /home/tenki/broker && npm install --omit=dev'
# systemd unit at /etc/systemd/system/tenki-broker.service; ExecStart needs the REAL node path:
#   /usr/local/nvm/versions/node/v24.14.0/bin/node
# then: systemctl daemon-reload && systemctl enable --now tenki-broker

# 5. bind. If the URL is still bound to the DEAD host, unbind first or bind fails
#    with "already_exists: preview URL is already bound".
tenki sandbox preview-url unbind <STICKY_ID>
tenki sandbox preview-url bind   <STICKY_ID> --session $HOST --port 8080
```

`.env` contents (gitignored, never in the repo):
```
TENKI_API_KEY=<the CLI's own token — recover from ~/.config/tenki/config.yaml auth_token>
BROKER_PUBLIC_URL=https://sandboxmaxxing--<suffix>.us.sb.tenki.sh   # MUST include .us.
PORT=8080
SITE_DIR=/home/tenki/site
DEMO_ENABLED=true
MAX_DEMO_SANDBOXES=4
# plus the provider keys above
```

**Note the `.us.` infix** — the region-less `…--<suffix>.sb.tenki.sh` form 404s. Always use
the `.us.` form, including for `BROKER_PUBLIC_URL`.

## Architecture

- **`index.html`** — the entire front end, one self-contained page, no build step.
- **`broker/broker.js`** — serves the site, mints demo sandboxes, exposes ports, and runs
  the **relay**: a reverse proxy holding the real API keys so sandboxes never see them.
  Each seat gets a scoped, call-capped, revocable per-session token instead.
- **`broker/maxx.js`** — the arena: team layout, per-harness seat launch, rounds, judging.
- **`broker/teams/*.json`** — rosters as data. `full-24.json` is canonical; a team of N takes
  the first N seats (architect always seat 0).
- **`broker/seat/websearch-mcp.js`** — MCP shim giving seats web search through the relay.

Relay upstreams are keyed per provider *and per harness* where the model differs
(`aisa-claude` pins a Claude model, `aisa-codex` pins a GPT one) because `forceModel()` is
per-upstream.

## Gotchas that will cost you hours

Full detail lives in **[`skills/agent-provider-inject`](skills/agent-provider-inject/)** —
read it before touching harness config. The short list:

- **kimirelay is Nebius-shaped.** It rewrites requests, so pointing it at a non-Nebius
  endpoint returns `400 … system.0: Input does not match the expected shape` even when curl
  to that endpoint works. claude and codex on Aisa therefore **bypass kimirelay** and talk to
  the relay directly.
- **Never set `ANTHROPIC_API_KEY` in a seat** — the base image ships one, and any value makes
  claude stop at "Detected a custom API key… use this?". Use `ANTHROPIC_AUTH_TOKEN` and
  explicitly `unset ANTHROPIC_API_KEY`.
- **claude and codex each have multiple headless gates** that their bypass flags do *not*
  cover (theme picker, folder trust, sign-in). All are pre-seeded in `maxx.js`.
- **TOML root keys must precede every `[table]` header**, or codex silently ignores your
  provider and falls back to `api.openai.com`.
- **`codex` needs a TTY; `codex exec` does not.**
- **Reasoning models exceed proxy header timeouts.** Kimi-K3 measured 149.9s to first byte;
  `RELAY_HEADER_TIMEOUT_MS` is 300s for this reason. A short timeout surfaces as an upstream
  502 that is actually ours.
- **A bare `nohup … &` server dies with the agent's tool call** — seats get a `tenki-serve`
  helper using `setsid` so published apps stay up.
- **`tenki sandbox write` only accepts paths under `/home/tenki`**, and flakes with transient
  502s. Retry in a loop.

## Known external risk

Cloudflare Gateway has categorised `*.sb.tenki.sh` as **"DNS Tunneling / Security threats /
CIPA"**. Anyone behind Cloudflare Zero Trust or a family-safe resolver gets a browser
**certificate warning** instead of the site — it looks like our bug and isn't. Diagnose with
`dig +short <host>` vs `dig +short @8.8.8.8 <host>`; differing answers mean DNS filtering.
The domain proxy works around this for the main site, but **per-agent preview URLs are still
exposed**. Worth raising with Tenki.

## Also in this repo

- `SANDBOX-VS-WORKTREE.md` — evidence brief, 32 fact-checked sources, including an honest
  section on where our argument is weak.
- `SANDBOXMAXXING.md` — the feature spec.
- `skills/agent-provider-inject/` — reusable, published skill.
