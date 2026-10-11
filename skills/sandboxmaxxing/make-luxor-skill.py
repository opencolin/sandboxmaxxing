#!/usr/bin/env python3
"""Build SKILL.luxor.md — the Luxor-branded skill served at luxor.sh/skill.md — from SKILL.md.

Only the branding differs: name, description, title, intro, the install location, and the
URLs it installs from. The instructions are shared, so they cannot drift. The engine's real
identifiers (arena.sh, the .sandboxmaxxing/ state dir, smx- sandbox names, the
sandboxmaxxing= metadata) are kept, because the doc must describe what the scripts actually
do. Every substitution must match exactly once, or this fails instead of quietly shipping a
half-branded file. Run it after editing SKILL.md, then push both (see HANDOFF.md).
"""
import pathlib, sys

here = pathlib.Path(__file__).parent
src = (here / "SKILL.md").read_text()

SUBS = [
    ("name: sandboxmaxxing\n", "name: luxor-swarm\n"),
    ("description: Race several coding agents (Claude Code, Codex, OpenCode) on the same task, each in its own disposable Tenki cloud sandbox on the user's own account,",
     "description: Run a Luxor agent swarm — race several coding agents (Claude Code, Codex, OpenCode) on the same task, each in its own throwaway Linux computer on the user's own Tenki account,"),
    ("# Sandboxmaxxing: race coding agents in throwaway sandboxes\n",
     "# Luxor agent swarms: race coding agents in throwaway computers\n"),
    ("""One prompt goes to several agents. Each builds independently in its own Tenki microVM — on
the user's Tenki account, with the user's model keys — and serves its result on a live
preview URL. **You** judge the builds, keep the winner, and the rest turn to sand.
""",
     """One prompt goes to a swarm of coding agents. Each builds independently in its own throwaway
Linux computer — a Tenki microVM on the user's Tenki account, with the user's model keys — and
serves its result on a live preview URL. **You** judge the builds, keep the winner, and the rest
are torn down.

From [luxor.sh](https://luxor.sh). The scripts keep their engine's names — `arena.sh`, the
`.sandboxmaxxing/` state folder, `smx-` sandbox names — so expect those below.
"""),
    ("D=~/.claude/skills/sandboxmaxxing     #", "D=~/.claude/skills/luxor-swarm       #"),
    ("https://sandboxmaxxing.com/skill.md                 ", "https://luxor.sh/skill.md                 "),
    ("https://sandboxmaxxing.com/skill/arena.sh           ", "https://luxor.sh/skill/arena.sh           "),
    ("https://sandboxmaxxing.com/skill/inject-provider.sh ", "https://luxor.sh/skill/inject-provider.sh "),
    ("Say what it costs before a big arena.", "Say what it costs before a big swarm."),
]
out = src
for old, new in SUBS:
    n = out.count(old)
    if n != 1:
        sys.exit(f"make-luxor-skill: expected 1 match, found {n}: {old[:60]!r}")
    out = out.replace(old, new)
if "sandboxmaxxing.com" in out:
    sys.exit("make-luxor-skill: a sandboxmaxxing.com URL survived")
(here / "SKILL.luxor.md").write_text(out)
print("wrote SKILL.luxor.md")
