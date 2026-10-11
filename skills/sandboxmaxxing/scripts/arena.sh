#!/usr/bin/env bash
# sandboxmaxxing arena: race coding agents on one prompt, each in its own disposable
# Tenki sandbox, on YOUR Tenki account and YOUR model keys. You (the calling agent)
# judge the results, keep the winner, and tear the rest down.
#
#   arena.sh run     --prompt TEXT [--agents claude,codex,opencode] [--minutes 45]
#                    [--base URL --key-env VAR] [--claude-model M] [--codex-model M]
#                    [--opencode-model M] [--cpu 2] [--memory-mb 4096] [--disk-gb 10]
#   arena.sh status  [ARENA]            state of every contestant, preview URL once serving
#   arena.sh logs    [ARENA] N [LINES]  tail of contestant N's agent output
#   arena.sh collect [ARENA] [DIR]      download each contestant's work dir to DIR/N-agent/
#   arena.sh keep    [ARENA] N          keep the winner past --minutes; print its preview URL
#   arena.sh stop    [ARENA]            terminate every contestant that was not kept
#   arena.sh list                       arenas recorded in ./.sandboxmaxxing/
#
# ARENA defaults to the most recent one. State lives in ./.sandboxmaxxing/<arena>.json.
# Every sandbox carries metadata sandboxmaxxing=<arena> and a "smx-<arena>-" name, and
# this script only ever acts on sandboxes that match BOTH. Each one also self-destructs
# after --minutes, so a forgotten arena stops costing money on its own.
#
# Keys: with --base/--key-env every agent goes through that gateway (Aisa, OpenRouter, any
# OpenAI/Anthropic-compatible endpoint). Without it, claude uses $ANTHROPIC_API_KEY, codex
# uses $OPENAI_API_KEY, and opencode runs its own free models with no key at all. Keys
# reach a sandbox as a file written over the Tenki API, never on a command line, and live
# OUTSIDE the directory the agent builds in, so they cannot be committed or collected.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STATE_DIR="${SANDBOXMAXXING_STATE_DIR:-$PWD/.sandboxmaxxing}"
WORK=/home/tenki/work
die() { echo "arena: $*" >&2; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || die "$1 not found — $2"; }
need tenki "install it: curl -fsSL https://tenki.cloud/install.sh | bash, then: tenki login"
need python3 "python3 is required for JSON handling"

# The Tenki API flakes with transient 5xx now and then; every remote call retries.
retry() { local i; for i in 1 2 3 4; do "$@" && return 0; sleep $((i * 2)); done; return 1; }
# `tenki sandbox exec` prints the remote output, then a blank line and a status block
# (status / exit_code / duration / reason) on STDOUT, and exits with the REMOTE exit
# code. So: strip the block, return the remote result, and retry only when the block
# is missing — the call never reached the sandbox — not when the command itself failed.
rexec() {
  local id="$1"; shift; local out i
  for i in 1 2 3 4; do
    out="$(tenki sandbox exec --session "$id" -- bash -lc "$*" 2>&1)" || true
    if printf '%s\n' "$out" | grep -q '^status *: '; then
      printf '%s\n' "$out" | sed -e '/^status *: /,$d' | sed -e '${/^$/d;}'
      printf '%s\n' "$out" | grep -qE '^exit_code *: *0$'; return
    fi
    sleep $((i * 2))
  done
  echo "arena: could not reach sandbox $id" >&2; return 1
}
rwrite() { retry tenki sandbox write --session "$1" --path "$2" --data-file "$3" >/dev/null; }
jget() { python3 -c "import json,sys; d=json.load(open(sys.argv[1])); print(eval(sys.argv[2]))" "$@"; }

resolve() {   # resolve ARENA (or latest) -> path of its state file
  local a="${1:-}"
  [ -z "$a" ] && [ -f "$STATE_DIR/latest" ] && a="$(cat "$STATE_DIR/latest")"
  [ -n "$a" ] || die "no arena yet — start one with: arena.sh run --prompt \"...\""
  [ -f "$STATE_DIR/$a.json" ] || die "unknown arena '$a' (see: arena.sh list)"
  echo "$STATE_DIR/$a.json"
}

# Defence in depth: refuse to touch a sandbox unless it carries this arena's metadata
# and name prefix, so a stale or edited state file can never reach anything else.
owned() {   # owned ARENA ID -> exit 0 if the sandbox belongs to ARENA
  tenki sandbox list --json 2>/dev/null | python3 -c '
import json,sys
arena, sid = sys.argv[1], sys.argv[2]
for s in json.load(sys.stdin):
    if s.get("id") == sid:
        md = s.get("metadata") or {}
        ok = md.get("sandboxmaxxing") == arena and str(s.get("name","")).startswith("smx-%s-" % arena)
        sys.exit(0 if ok else 1)
sys.exit(1)' "$1" "$2"
}

contestants() {   # print "n agent id" per line from a state file
  python3 -c '
import json,sys
for c in json.load(open(sys.argv[1]))["contestants"]: print(c["n"], c["agent"], c["id"])' "$1"
}

suffix() { cat <<'EOF'

---
You are one of several agents building this independently, each in its own sandbox. The
best build wins, judged on whether it works and how well it meets the brief.
- Work in /home/tenki/work. Do not ask questions: make reasonable decisions and finish.
- When it works, serve it on port 3000 DETACHED so it outlives you, e.g.
    setsid nohup <your serve command> >/home/tenki/serve.log 2>&1 </dev/null &
  then confirm with: curl -s localhost:3000 >/dev/null && echo serving
- Write /home/tenki/work/SUMMARY.md: what you built, how to run it, what you verified.
EOF
}

cmd_run() {
  local prompt="" agents="claude,codex,opencode" minutes=45 base="" keyenv=""
  local cmodel="claude-sonnet-5" xmodel="gpt-5.3-codex" omodel="" cpu=2 mem=4096 disk=10
  while [ $# -gt 0 ]; do case "$1" in
    --prompt) prompt="$2"; shift 2;;        --agents) agents="$2"; shift 2;;
    --minutes) minutes="$2"; shift 2;;      --base) base="${2%/}"; shift 2;;
    --key-env) keyenv="$2"; shift 2;;       --claude-model) cmodel="$2"; shift 2;;
    --codex-model) xmodel="$2"; shift 2;;   --opencode-model) omodel="$2"; shift 2;;
    --cpu) cpu="$2"; shift 2;;              --memory-mb) mem="$2"; shift 2;;
    --disk-gb) disk="$2"; shift 2;;         *) die "unknown option: $1";; esac; done
  [ -n "$prompt" ] || die "--prompt is required"
  [ -z "$base" ] || [ -n "$keyenv" ] || die "--base needs --key-env NAME (the env var holding the key)"
  local key=""; [ -n "$keyenv" ] && { key="${!keyenv:-}"; [ -n "$key" ] || die "\$$keyenv is empty"; }
  # Keys are written into a single-quoted env file; a quote in one would break it.
  for v in "$key" "${ANTHROPIC_API_KEY:-}" "${OPENAI_API_KEY:-}"; do case "$v" in *"'"*) die "a key contains a single quote";; esac; done

  # Pre-flight: an agent that cannot authenticate wastes a sandbox and reports nothing.
  local a; IFS=, read -ra list <<<"$agents"
  for a in "${list[@]}"; do case "$a" in
    claude)   [ -n "$base" ] || [ -n "${ANTHROPIC_API_KEY:-}" ] || die "claude needs \$ANTHROPIC_API_KEY or --base/--key-env";;
    codex)    [ -n "$base" ] || [ -n "${OPENAI_API_KEY:-}" ] || die "codex needs \$OPENAI_API_KEY or --base/--key-env";;
    opencode) ;;
    *) die "unsupported agent '$a' (claude, codex, opencode)";; esac; done

  local arena; arena="$(python3 -c 'import secrets; print(secrets.token_hex(3))')"
  mkdir -p "$STATE_DIR"; chmod 700 "$STATE_DIR"
  # Self-ignoring: state and downloaded results never get committed, even when run from
  # inside someone's repo, without editing their .gitignore.
  [ -f "$STATE_DIR/.gitignore" ] || printf '*\n' > "$STATE_DIR/.gitignore"
  # Holds the key file. GLOBAL, and removed by an EXIT trap: die() exits the script (a
  # RETURN trap would not fire), and the trap runs after this function's locals are gone.
  SMX_TMP="$(mktemp -d)"; chmod 700 "$SMX_TMP"; trap 'rm -rf "${SMX_TMP:-}"' EXIT
  local tmp="$SMX_TMP"
  { printf '%s\n' "$prompt"; suffix; } > "$tmp/prompt.txt"
  local omodel_eff="${omodel:-opencode/nemotron-3-ultra-free}"
  [ -n "$base" ] && omodel_eff="relay/${omodel:-$cmodel}"

  local n=0 json='[]'
  echo "arena $arena: ${#list[@]} contestant(s), self-destruct in ${minutes}m"
  for a in "${list[@]}"; do
    n=$((n + 1)); local name="smx-$arena-$n-$a" out id
    out="$(retry tenki sandbox create --name "$name" --cpu "$cpu" --memory-mb "$mem" --disk-size-gb "$disk" \
            --max-duration "${minutes}m" --metadata "sandboxmaxxing=$arena" --metadata "contestant=$n" --json)" \
      || die "could not create $name"
    id="$(printf '%s' "$out" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d.get("id") or (d.get("session") or {}).get("id",""))')"
    [ -n "$id" ] || die "no id in create output for $name"
    json="$(python3 -c 'import json,sys; l=json.loads(sys.argv[1]); l.append({"n":int(sys.argv[2]),"agent":sys.argv[3],"id":sys.argv[4],"name":sys.argv[5]}); print(json.dumps(l))' "$json" "$n" "$a" "$id" "$name")"
    # Record as we go: if a later step dies, stop can still find what was created.
    python3 -c 'import json,sys; json.dump({"arena":sys.argv[1],"prompt":sys.argv[2],"minutes":int(sys.argv[3]),"contestants":json.loads(sys.argv[4]),"kept":[]},open(sys.argv[5],"w"),indent=2)' \
      "$arena" "$prompt" "$minutes" "$json" "$STATE_DIR/$arena.json"
    echo "$arena" > "$STATE_DIR/latest"

    # --- keys: a 0600 file outside the work dir, sourced by the launcher
    : > "$tmp/keys.env"; chmod 600 "$tmp/keys.env"
    if [ -n "$base" ]; then
      printf "SMX_KEY='%s'\n" "$key" >> "$tmp/keys.env"
    else
      [ "$a" = claude ] && printf "export ANTHROPIC_API_KEY='%s'\n" "$ANTHROPIC_API_KEY" >> "$tmp/keys.env"
      [ "$a" = codex ]  && printf "export OPENAI_API_KEY='%s'\n" "$OPENAI_API_KEY" >> "$tmp/keys.env"
    fi
    rwrite "$id" /home/tenki/.smx-keys.env "$tmp/keys.env"
    rwrite "$id" /home/tenki/prompt.txt "$tmp/prompt.txt"
    [ -n "$base" ] && rwrite "$id" /home/tenki/inject-provider.sh "$HERE/inject-provider.sh"

    cat > "$tmp/run.sh" <<EOF
#!/bin/bash
export PATH="\$HOME/.local/bin:/usr/local/bin:\$PATH"
cd $WORK
. /home/tenki/.smx-keys.env
[ -f /home/tenki/.agent-provider.env ] && . /home/tenki/.agent-provider.env
P="\$(cat /home/tenki/prompt.txt)"
# opencode's free tier refuses clients older than 1.18.0, and stock images have shipped
# 1.17.x. Upgrade only when below it (sort -V: the smaller version sorts first).
old_opencode() { v="\$(opencode --version 2>/dev/null | tail -1)"; [ "\$(printf '%s\n1.18.0\n' "\$v" | sort -V | head -1)" != "1.18.0" ]; }
case "$a" in
  claude)   claude -p --dangerously-skip-permissions "\$P" ;;
  codex)    codex exec --dangerously-bypass-approvals-and-sandbox --skip-git-repo-check "\$P" ;;
  opencode) if old_opencode; then echo "updating opencode (the free tier needs 1.18+)"
              sudo -n npm install -g --prefix /usr/local opencode-ai@latest >/home/tenki/opencode-upgrade.log 2>&1 \\
                || npm install -g opencode-ai@latest >>/home/tenki/opencode-upgrade.log 2>&1; fi
            opencode run --model "$omodel_eff" "\$P" ;;
esac > /home/tenki/agent.log 2>&1
echo \$? > /home/tenki/agent.exit
EOF
    rwrite "$id" /home/tenki/run.sh "$tmp/run.sh"

    # --- per-agent setup, then launch detached so it survives this call
    local setup="chmod 600 /home/tenki/.smx-keys.env; mkdir -p $WORK; cd $WORK; git init -q 2>/dev/null || true"
    # claude: skip the first-run onboarding and folder-trust gates.
    setup+="; [ -s ~/.claude.json ] || printf '%s' '{\"hasCompletedOnboarding\":true,\"theme\":\"dark\",\"bypassPermissionsModeAccepted\":true,\"projects\":{\"$WORK\":{\"hasTrustDialogAccepted\":true}}}' > ~/.claude.json"
    if [ -n "$base" ]; then
      # Gateway mode. --workdir is HOME, not the build dir: the script writes the key into
      # <workdir>/.agent-provider.env and opencode.json. opencode's file then moves to its
      # global config, where it is still read but sits outside the project.
      setup+="; . /home/tenki/.smx-keys.env; bash /home/tenki/inject-provider.sh --base '$base' --key \"\$SMX_KEY\" --workdir /home/tenki --claude-model '$cmodel' --codex-model '$xmodel' --opencode-model '${omodel:-$cmodel}' >/home/tenki/inject.log 2>&1"
      setup+="; mkdir -p ~/.config/opencode; [ -f /home/tenki/opencode.json ] && mv /home/tenki/opencode.json ~/.config/opencode/opencode.json; rm -f /home/tenki/inject-provider.sh"
    elif [ "$a" = codex ]; then
      # Native codex: it needs a stored login, not just the env var, and a trusted project.
      setup+="; . /home/tenki/.smx-keys.env; printenv OPENAI_API_KEY | codex login --with-api-key >/dev/null 2>&1 || true"
      setup+="; mkdir -p ~/.codex; printf '[projects.\"$WORK\"]\ntrust_level = \"trusted\"\n' >> ~/.codex/config.toml"
    fi
    # Detached with setsid so it outlives this exec call; no tmux (the stock image has
    # none). The pidfile is how status tells "running" from "died without finishing".
    setup+="; chmod 600 /home/tenki/.agent-provider.env 2>/dev/null; setsid nohup bash /home/tenki/run.sh >/dev/null 2>&1 </dev/null & echo \$! > /home/tenki/agent.pid"
    setup+="; sleep 1; { [ -f /home/tenki/agent.exit ] || kill -0 \$(cat /home/tenki/agent.pid) 2>/dev/null; } && echo LAUNCHED"
    # Capture, then match: `| grep -q` exits on the first match and, under pipefail,
    # the SIGPIPE it hands the writer would read as a failed launch.
    local launched; launched="$(rexec "$id" "$setup" || true)"
    [[ "$launched" == *LAUNCHED* ]] || die "contestant $n ($a) did not launch — check: tenki sandbox exec --session $id -- cat /home/tenki/inject.log"
    echo "  $n. $a  $id  launched"
  done
  echo
  echo "Watch:   $(basename "$0") status        (every minute or so)"
  echo "Peek:    $(basename "$0") logs N"
  echo "Results: $(basename "$0") collect       then judge, keep N, stop"
}

cmd_status() {
  local f; f="$(resolve "${1:-}")"; local arena; arena="$(jget "$f" 'd["arena"]')"
  printf '%-3s %-9s %-12s %s\n' N AGENT STATE PREVIEW
  local n a id st url
  while read -r n a id; do
    # One line, "<state> <http code of :3000>", so the two can be split apart below.
    st="$(rexec "$id" 's=stopped; if [ -f /home/tenki/agent.exit ]; then s="done(exit-$(cat /home/tenki/agent.exit))"; elif kill -0 "$(cat /home/tenki/agent.pid 2>/dev/null || echo 0)" 2>/dev/null; then s=running; fi; c=$(curl -s -o /dev/null -m 3 -w "%{http_code}" localhost:3000 || true); echo "$s ${c:-000}"' 2>/dev/null | tail -1 || echo "unreachable 000")"
    url="$(python3 -c 'import json,sys; c=[c for c in json.load(open(sys.argv[1]))["contestants"] if c["n"]==int(sys.argv[2])][0]; print(c.get("url",""))' "$f" "$n")"
    if [ -z "$url" ] && [ "${st##* }" = 200 ] && owned "$arena" "$id"; then
      url="$(retry tenki sandbox expose --session "$id" --port 3000 --json 2>/dev/null | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d.get("preview_url") or d.get("previewUrl") or d.get("url") or "")' || true)"
      [ -n "$url" ] && python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); [c.update(url=sys.argv[3]) for c in d["contestants"] if c["n"]==int(sys.argv[2])]; json.dump(d,open(sys.argv[1],"w"),indent=2)' "$f" "$n" "$url"
    fi
    printf '%-3s %-9s %-12s %s\n' "$n" "$a" "${st% *}" "${url:-—}"
  done < <(contestants "$f")
}

# logs/keep take an optional ARENA before N: treat the first argument as an arena only
# if one by that name exists, so "logs 1 25" means contestant 1, 25 lines.
take_arena() { if [ $# -gt 0 ] && [ -f "$STATE_DIR/$1.json" ]; then echo "$1"; fi; }

cmd_logs() {
  local arena; arena="$(take_arena "$@")"; [ -n "$arena" ] && shift
  local f; f="$(resolve "$arena")"; local n="${1:?usage: logs [ARENA] N [LINES]}" lines="${2:-40}" id
  id="$(python3 -c 'import json,sys; print([c["id"] for c in json.load(open(sys.argv[1]))["contestants"] if c["n"]==int(sys.argv[2])][0])' "$f" "$n")" || die "no contestant $n"
  rexec "$id" "tail -n $lines /home/tenki/agent.log 2>/dev/null || echo '(no output yet)'"
}

cmd_collect() {
  local f; f="$(resolve "${1:-}")"; local arena; arena="$(jget "$f" 'd["arena"]')"
  local dir="${2:-$PWD/.sandboxmaxxing/$arena-results}" n a id; mkdir -p "$dir"
  while read -r n a id; do
    owned "$arena" "$id" || { echo "  $n. $a  skipped (sandbox gone or not ours)"; continue; }
    rexec "$id" "tar czf /home/tenki/work.tgz -C /home/tenki --exclude=node_modules --exclude=.venv work; cp /home/tenki/agent.log $WORK/AGENT.log 2>/dev/null; echo ok" >/dev/null
    mkdir -p "$dir/$n-$a"
    retry tenki sandbox read --session "$id" --path /home/tenki/work.tgz --out "$dir/$n-$a.tgz" >/dev/null
    tar xzf "$dir/$n-$a.tgz" -C "$dir/$n-$a" --strip-components=1 && rm -f "$dir/$n-$a.tgz"
    retry tenki sandbox read --session "$id" --path /home/tenki/agent.log --out "$dir/$n-$a/AGENT.log" >/dev/null 2>&1 || true
    echo "  $n. $a  -> $dir/$n-$a"
  done < <(contestants "$f")
  echo "Judge each: read SUMMARY.md, run what is there, open the preview from 'status'."
}

cmd_keep() {
  local a; a="$(take_arena "$@")"; [ -n "$a" ] && shift
  local f; f="$(resolve "$a")"; local arena; arena="$(jget "$f" 'd["arena"]')"
  local n="${1:?usage: keep [ARENA] N}" id
  id="$(python3 -c 'import json,sys; print([c["id"] for c in json.load(open(sys.argv[1]))["contestants"] if c["n"]==int(sys.argv[2])][0])' "$f" "$n")" || die "no contestant $n"
  owned "$arena" "$id" || die "contestant $n's sandbox is gone or not part of arena $arena"
  # `update` takes the session POSITIONALLY (unlike exec/write/read/expose/terminate),
  # and the CLI exits 0 even on a usage error. So never trust its exit code: read
  # sticky back from the platform and refuse to claim success unless it is set.
  tenki sandbox update --sticky "$id" >/dev/null 2>&1 || true
  local sticky; sticky="$(tenki sandbox list --json 2>/dev/null | python3 -c 'import json,sys; print(next((s.get("sticky") for s in json.load(sys.stdin) if s["id"]==sys.argv[1]), None))' "$id")"
  [ "$sticky" = True ] || die "could not make contestant $n sticky (platform reports sticky=$sticky) — it will still self-destruct"
  python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); k=set(d.get("kept",[])); k.add(int(sys.argv[2])); d["kept"]=sorted(k); json.dump(d,open(sys.argv[1],"w"),indent=2)' "$f" "$n"
  echo "kept contestant $n ($id): sticky, survives the ${arena} self-destruct"
  cmd_status "$arena" | awk -v n="$n" 'NR==1 || $1==n'
}

cmd_stop() {
  local f; f="$(resolve "${1:-}")"; local arena; arena="$(jget "$f" 'd["arena"]')"
  local kept; kept=" $(jget "$f" '" ".join(str(k) for k in d.get("kept",[]))') "
  local n a id
  while read -r n a id; do
    case "$kept" in *" $n "*) echo "  $n. $a  kept"; continue;; esac
    if owned "$arena" "$id"; then retry tenki sandbox terminate --session "$id" >/dev/null && echo "  $n. $a  terminated"
    else echo "  $n. $a  already gone"; fi
  done < <(contestants "$f")
}

cmd_list() {
  [ -d "$STATE_DIR" ] || { echo "no arenas yet"; return; }
  for f in "$STATE_DIR"/*.json; do [ -e "$f" ] || continue
    python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); print("%s  %d contestant(s)  kept=%s  %s" % (d["arena"], len(d["contestants"]), d.get("kept",[]), d["prompt"][:60]))' "$f"; done
}

case "${1:-}" in
  run) shift; cmd_run "$@";;          status) shift; cmd_status "$@";;
  logs) shift; cmd_logs "$@";;        collect) shift; cmd_collect "$@";;
  keep) shift; cmd_keep "$@";;        stop) shift; cmd_stop "$@";;
  list) cmd_list;;
  *) sed -n '2,25p' "$0" | sed 's/^# \{0,1\}//'; exit 1;;
esac
