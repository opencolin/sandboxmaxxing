# sandboxmaxxing

**Run competing teams of AI coding agents in disposable cloud sandboxes — watch them work live, pick a winner, iterate.**

🔗 **[sandboxmaxxing.com](https://sandboxmaxxing.com)**

Built on [Tenki Cloud](https://tenki.cloud) microVMs. One prompt fans out to a team (or two rival
teams) of agents, each in its own sandbox with its own filesystem, ports and processes. You watch
any agent's terminal live, type to it mid-run, then choose the build you like — its code becomes
the shared base and every team iterates on it.

## What's here

| | |
|---|---|
| `index.html` | The whole front end — one self-contained page, no build step |
| `broker/` | Node service: serves the site, mints sandboxes, orchestrates runs, proxies inference |
| `broker/maxx.js` | The arena — team layout, seat launch per harness, rounds, judging |
| `broker/teams/` | Agent rosters as data (24 roles; a team of N takes the first N) |
| `skills/agent-provider-inject/` | **[Reusable skill](skills/agent-provider-inject/)** — point claude/codex/opencode at any inference provider |

## Features

- **Three harnesses** — `claude`, `codex`, `opencode`, each headless in its own sandbox
- **Four providers** — Aisa, OpenRouter, Nebius Token Factory, or opencode's free models, switchable per run
- **Theater view** — one live agent terminal plus a rail of every seat; click to switch, type to steer
- **A/B arena** — two teams build the same brief; a judge scores them, or you decide
- **Iterative rounds** — pick a winner and its code is copied over every other sandbox, with your feedback, and they all improve it
- **1 / 4 / 12 / 24 agents** per team
- **Live deliverables** — every agent publishes to a real URL and the results embed side by side

## Why sandboxes, not git worktrees

Worktrees share one kernel: one port space, one set of global installs, one filesystem. Four agents
told to "build an app and serve it" collide immediately. Sandboxes don't — every seat serves on
`:3000` and publishes its own URL.

Anthropic's own docs note that a worktree still shares `.git`, project-scope plugins **and saved
permission approvals** with the main checkout, and that `--dangerously-skip-permissions` sessions
belong in a container or VM. See [SANDBOX-VS-WORKTREE.md](SANDBOX-VS-WORKTREE.md) for the full
evidence brief — including where the argument is weak.

## Security model

No real credential ever enters a sandbox — visitors are root in theirs. Each session gets scoped,
call-capped, revocable tokens; the broker swaps in the real API key server-side and proxies. A
leaked token is worthless anywhere else, and the design fails closed.

## Run it

```bash
cd broker && npm install && node broker.js     # needs broker/.env (see broker.js header)
```

Front end is static — open `index.html` directly for UI work.

Deploying to a Tenki sandbox, restoring the host after it dies, and the current state of the live
deployment are all in **[HANDOFF.md](HANDOFF.md)**.

## Reusable skills

[`skills/sandboxmaxxing`](skills/sandboxmaxxing/) gives your own coding agent the arena: one
prompt raced across Claude Code, Codex and OpenCode, each in its own throwaway Tenki sandbox on
your account and your keys. The agent judges the builds, keeps the best and tears down the rest.
Paste this into Claude Code or Codex:

> Install the sandboxmaxxing skill from
> https://github.com/opencolin/sandboxmaxxing/tree/main/skills/sandboxmaxxing
> and run an arena for: *your task*

[`skills/agent-provider-inject`](skills/agent-provider-inject/) packages the hard part of this
project for any codebase: pointing agent CLIs at a custom inference endpoint, and the failure modes
that each blame the provider rather than your config (kimirelay's Nebius-shaped rewriting,
`ANTHROPIC_API_KEY` triggering an approval prompt, TOML root keys silently absorbed into a table,
reasoning models tripping proxy timeouts).
