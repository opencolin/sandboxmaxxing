#!/usr/bin/env bash
# Point claude / codex / opencode at a custom inference endpoint.
#
#   inject-provider.sh --base https://api.aisa.one --key sk-... \
#       [--claude-model claude-sonnet-5] [--codex-model gpt-5.3-codex] \
#       [--opencode-model some-model] [--workdir /home/tenki/work] [--harness all]
#
# Writes: ~/.claude.json, ~/.codex/config.toml, ~/.codex/auth.json,
#         <workdir>/opencode.json, and <workdir>/.agent-provider.env
# Source the .env file before launching an agent:  . <workdir>/.agent-provider.env
set -euo pipefail

BASE=""; KEY=""; WORKDIR="$PWD"; HARNESS="all"
CLAUDE_MODEL=""; CODEX_MODEL=""; OPENCODE_MODEL=""; CODEX_WIRE="responses"
while [ $# -gt 0 ]; do
  case "$1" in
    --base) BASE="${2%/}"; shift 2;;
    --key) KEY="$2"; shift 2;;
    --workdir) WORKDIR="$2"; shift 2;;
    --harness) HARNESS="$2"; shift 2;;
    --claude-model) CLAUDE_MODEL="$2"; shift 2;;
    --codex-model) CODEX_MODEL="$2"; shift 2;;
    --opencode-model) OPENCODE_MODEL="$2"; shift 2;;
    --codex-wire) CODEX_WIRE="$2"; shift 2;;
    -h|--help) sed -n '2,12p' "$0"; exit 0;;
    *) echo "unknown arg: $1" >&2; exit 2;;
  esac
done
[ -n "$BASE" ] && [ -n "$KEY" ] || { echo "--base and --key are required" >&2; exit 2; }
mkdir -p "$WORKDIR"
want() { [ "$HARNESS" = "all" ] || [ "$HARNESS" = "$1" ]; }
ENVF="$WORKDIR/.agent-provider.env"; : > "$ENVF"

if want claude; then
  # ANTHROPIC_BASE_URL is the ORIGIN; the CLI appends /v1/messages itself.
  # ANTHROPIC_API_KEY must be UNSET — any value triggers a blocking approval prompt.
  {
    echo "export ANTHROPIC_BASE_URL='$BASE'"
    echo "export ANTHROPIC_AUTH_TOKEN='$KEY'"
    echo "unset ANTHROPIC_API_KEY"
    [ -n "$CLAUDE_MODEL" ] && echo "export ANTHROPIC_MODEL='$CLAUDE_MODEL'"
  } >> "$ENVF"
  # Pre-seed the first-run gates: theme picker + per-folder trust dialog.
  python3 - "$HOME/.claude.json" "$WORKDIR" <<'PY'
import json,os,sys
p,wd=sys.argv[1],sys.argv[2]
try: cfg=json.load(open(p))
except Exception: cfg={}
cfg.update({"hasCompletedOnboarding":True,"theme":cfg.get("theme","dark"),"bypassPermissionsModeAccepted":True})
proj=cfg.setdefault("projects",{}).setdefault(wd,{})
proj.update({"hasTrustDialogAccepted":True,"projectOnboardingSeenCount":1})
proj.setdefault("allowedTools",[])
json.dump(cfg,open(p,"w"))
print("  claude: ~/.claude.json seeded")
PY
fi

if want codex; then
  # TOML: root keys MUST precede every [table] header or they are parsed into it.
  mkdir -p "$HOME/.codex"
  {
    [ -n "$CODEX_MODEL" ] && printf 'model = "%s"\n' "$CODEX_MODEL"
    printf 'model_provider = "relay"\n\n'
    printf '[model_providers.relay]\nname = "relay"\nbase_url = "%s/v1"\nenv_key = "OPENAI_API_KEY"\nwire_api = "%s"\n\n' "$BASE" "$CODEX_WIRE"
    printf '[projects."%s"]\ntrust_level = "trusted"\n' "$WORKDIR"
  } > "$HOME/.codex/config.toml"
  # env_key alone is not enough: without auth.json codex stops at a sign-in menu.
  printf '{"OPENAI_API_KEY":"%s"}' "$KEY" > "$HOME/.codex/auth.json"
  echo "export OPENAI_API_KEY='$KEY'" >> "$ENVF"
  echo "  codex: ~/.codex/config.toml + auth.json written"
fi

if want opencode; then
  python3 - "$WORKDIR/opencode.json" "$BASE" "$KEY" "$OPENCODE_MODEL" <<'PY'
import json,sys
path,base,key,model=sys.argv[1],sys.argv[2],sys.argv[3],sys.argv[4]
try: cfg=json.load(open(path))
except Exception: cfg={"$schema":"https://opencode.ai/config.json"}
cfg.setdefault("provider",{})["relay"]={
 "npm":"@ai-sdk/openai-compatible","name":"relay",
 "options":{"baseURL":base+"/v1","apiKey":key},
 "models":{model:{}} if model else {}}
json.dump(cfg,open(path,"w"),indent=2)
print("  opencode: %s written%s"%(path," (run with --model relay/%s)"%model if model else ""))
PY
fi

echo "done. source it before launching:  . $ENVF"
