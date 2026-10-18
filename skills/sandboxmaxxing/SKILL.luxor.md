---
name: luxor-swarm
description: Run a Luxor agent swarm — race several coding agents (Claude Code, Codex, OpenCode) on the same task, each in its own throwaway Linux computer on the user's own Tenki account, then judge the builds and keep the best. Use when the user wants best-of-N attempts at a build, wants to compare agents or models on a real task, or wants work done in isolated throwaway machines rather than on their laptop or in a git worktree.
---

# Luxor agent swarms: race coding agents in throwaway computers

One prompt goes to a swarm of coding agents. Each builds independently in its own throwaway
Linux computer — a Tenki microVM on the user's Tenki account, with the user's model keys — and
serves its result on a live preview URL. **You** judge the builds, keep the winner, and the rest
are torn down.

From [tenki.monster](https://tenki.monster). The scripts keep their engine's names — `arena.sh`, the
`.sandboxmaxxing/` state folder, `smx-` sandbox names — so expect those below.

The driver is `scripts/arena.sh` next to this file. Every command below assumes
`S=<this skill's dir>/scripts/arena.sh`.

## Install (if you're reading this from a URL)

If this file isn't already in a skills directory, install the skill — three files:

```bash
D=~/.claude/skills/luxor-swarm       # Codex or another agent: any directory you like
mkdir -p "$D/scripts"
curl -fsSL https://tenki.monster/skill.md                 -o "$D/SKILL.md"
curl -fsSL https://tenki.monster/skill/arena.sh           -o "$D/scripts/arena.sh"
curl -fsSL https://tenki.monster/skill/inject-provider.sh -o "$D/scripts/inject-provider.sh"
chmod +x "$D"/scripts/*.sh
S="$D/scripts/arena.sh"
```

## Before you start

1. **Tenki CLI, logged in.** `tenki sandbox list` must succeed. If `tenki` is missing:
   `curl -fsSL https://tenki.cloud/install.sh | bash`, then ask the user to run `tenki login`.
   Never ask for their Tenki key in chat.
2. **Model access, per agent:**
   - `opencode` — nothing; it runs its own free models.
   - `claude` — `ANTHROPIC_API_KEY` in the environment, or a gateway.
   - `codex` — `OPENAI_API_KEY` in the environment, or a gateway.
   - **Gateway** — one OpenAI/Anthropic-compatible endpoint serving every agent, e.g.
     `--base https://api.aisa.one --key-env AISA_API_KEY`. Pass the env var's **name**, never
     the key. The script refuses to launch an agent that cannot authenticate.
3. **Say what it costs before a big swarm.** Each contestant is a sandbox (default 2 cores,
   4 GB) for up to `--minutes`, plus its model usage. Tell the user N × minutes first.

## Run

```bash
$S run --prompt "<the user's task, with their constraints>" --agents claude,codex,opencode
```

- `claude,codex,opencode` compares agents. `claude,claude,claude` is best-of-3 from one
  agent. Only include agents the user can authenticate.
- `--minutes 45` (default): every sandbox self-destructs after this, even if you forget to
  stop. Raise it for big builds.
- The script appends instructions telling each agent to work in `/home/tenki/work`, serve
  its result on port 3000, and write `SUMMARY.md`. Don't repeat those in `--prompt`.

## Monitor

Poll `$S status` roughly once a minute; don't spin. States are `running`, `done(exit-N)`,
and `stopped` (died without finishing). A preview URL appears once a build answers on port
3000. Peek at one with `$S logs N`. Don't wait forever: at the deadline, judge what exists.

## Judge — you are the judge

`$S collect` downloads each contestant to `.sandboxmaxxing/<arena>-results/N-agent/`:
its code, `SUMMARY.md`, and `AGENT.log` (what the agent did). For each one:

1. Read `SUMMARY.md`, then the code.
2. Run its tests or build, if it has any.
3. Open its preview URL from `status`.

Judge on the result against the brief — does it work, how fully does it meet it, is the code
sound — never on which agent made it. Name a winner and give each contestant a sentence or
two. If none works, say so; don't crown a broken build.

## Finish

- `$S keep N` keeps the winner alive past `--minutes` and prints its URL. Only if the user
  wants it: a kept sandbox costs money until terminated.
- **Always** `$S stop` at the end. It terminates every contestant that was not kept.
- Report: the winner, its preview URL, the comparison, and where the results were saved.

## Rules

- Act only on sandboxes this arena created. The script enforces it — every sandbox carries
  `sandboxmaxxing=<arena>` metadata and an `smx-<arena>-` name, and it touches nothing else.
- Never print, log, or paste a key. Keys reach a sandbox as a file over the Tenki API, never
  on a command line, and live outside the directory the agent builds in, so they cannot be
  committed or come back in `collect`.
- `.sandboxmaxxing/` holds state and downloads; it ignores itself in git. Leave it that way.

## When something goes wrong

- **`done(exit-1)` within a minute:** `$S logs N`. Usually a missing or wrong key.
- **opencode "1.18.0 or newer is required":** the script upgrades opencode when it is older,
  which adds ~15s to its start. If it still fails, check `/home/tenki/opencode-upgrade.log`.
- **A build never gets a preview URL:** it didn't serve on port 3000. Judge its collected
  code instead.
- **Tenki API hiccups:** remote calls retry transient failures on their own.
