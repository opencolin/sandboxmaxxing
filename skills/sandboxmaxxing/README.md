# sandboxmaxxing skill

Give your coding agent its own arena. One prompt goes to several agents — Claude Code,
Codex, OpenCode, or several copies of one — each building independently in its own
disposable [Tenki](https://tenki.cloud) sandbox. Your agent judges the builds, keeps the
best, and tears down the rest.

It is the architecture behind [sandboxmaxxing.com](https://sandboxmaxxing.com), packaged to
run **on your own infrastructure**: your Tenki account, your model keys, nothing routed
through anyone else.

## Use it

Paste this into Claude Code, Codex, or any coding agent with a shell:

> Install the sandboxmaxxing skill from
> https://github.com/opencolin/sandboxmaxxing/tree/main/skills/sandboxmaxxing
> and run an arena with claude, codex and opencode for: *build a habit tracker with streaks*

### Install by hand

**Claude Code** — personal skills live in `~/.claude/skills/`:

```bash
git clone --depth 1 https://github.com/opencolin/sandboxmaxxing /tmp/sandboxmaxxing
mkdir -p ~/.claude/skills && cp -r /tmp/sandboxmaxxing/skills/sandboxmaxxing ~/.claude/skills/
```

Or per project: copy it into `.claude/skills/` in your repo.

**Codex and other agents** — clone it anywhere and tell the agent to follow
`skills/sandboxmaxxing/SKILL.md`. The driver is a plain bash script; nothing is
Claude-specific.

## What you need

- The Tenki CLI, logged in: `curl -fsSL https://tenki.cloud/install.sh | bash`, then
  `tenki login`.
- `python3` (for JSON handling).
- Model access for the agents you race:
  - **opencode** — none. It runs its own free models.
  - **claude** — `ANTHROPIC_API_KEY`, or a gateway.
  - **codex** — `OPENAI_API_KEY`, or a gateway.
  - **A gateway** serves all three through one key: any OpenAI/Anthropic-compatible
    endpoint, e.g. `--base https://api.aisa.one --key-env AISA_API_KEY`.

## Driving it yourself

```bash
S=~/.claude/skills/sandboxmaxxing/scripts/arena.sh
$S run --prompt "build a habit tracker with streaks" --agents claude,codex,opencode
$S status            # running / done(exit-N) / stopped, and a preview URL once serving
$S logs 2            # what contestant 2 is doing
$S collect           # download every build to .sandboxmaxxing/<arena>-results/
$S keep 1            # keep the winner alive; prints its URL
$S stop              # terminate everything that was not kept
```

## Cost and safety

- Each contestant is one sandbox (default 2 cores / 4 GB) plus its model usage.
- Every sandbox **self-destructs after `--minutes`** (default 45), so a forgotten arena stops
  costing money on its own. Only `keep` makes one outlive that.
- The script only ever touches sandboxes it created. Each carries `sandboxmaxxing=<arena>`
  metadata and an `smx-<arena>-` name, and both are checked before any change.
- Keys reach a sandbox as a file over the Tenki API, never on a command line. They live
  outside the directory the agent builds in, so they can't be committed by the agent or
  downloaded by `collect`. The sandboxes are yours, on your account. Prefer a key with a
  spend cap.
- `.sandboxmaxxing/` (state and downloads) ignores itself in git.

## How it was tested

On real Tenki sandboxes, end to end — launch, a working page on a live preview URL, then
`collect`, `keep` and `stop`:

- **claude** and **codex**, each through a gateway;
- **opencode** with no key at all;
- a **two-contestant arena**, tracked independently, both collected and judged, both
  stopped.

`collect` was checked to bring back no key material, and `keep` to actually leave the
winner sticky on the platform.
