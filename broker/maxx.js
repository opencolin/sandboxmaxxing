/* Sandboxmaxxing — configurable agent teams building one prompt in parallel
 * sandboxes. Supports two rival teams with a judge, Free (keyless opencode
 * native models) or Frontier (opencode → the broker's relay → Qwen3.8-27B, keys
 * server-side), and an optional starting repo (gortex-indexed per seat).
 *
 * Seats run HEADLESS — no per-seat preview URL — so a full 24-agent run costs
 * zero preview URLs; only each team's SHIPPED app takes one. Watchability is a
 * later on-demand add. Teams are data (broker/teams/*.json).
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { stdoutText } from "@tenkicloud/sandbox";

// Keyless opencode-native free models (verified unauthenticated). Free mode
// draws seat models here. north-mini-code-free is excluded (it errors).
const NATIVE_FREE = [
  "opencode/nemotron-3-ultra-free",   // strongest — seat 0 (lead) always gets this
  "opencode/big-pickle",
  "opencode/deepseek-v4-flash-free",
  "opencode/mimo-v2.5-free",
  "opencode/hy3-free",
];
// Frontier mode routes opencode through the broker relay to a hosted model.
// nebius/Qwen3.8-27B is genuinely stronger than the free tier; the seat sends its
// per-session relayToken as the bearer, so the real key never enters the VM.
const FRONTIER_PROVIDER = process.env.MAXX_FRONTIER_PROVIDER || "nebius";
const FRONTIER_MODEL = process.env.MAXX_FRONTIER_MODEL || "Qwen/Qwen3.8-27B";
// $0 judge: a strong OpenRouter free model scores the two builds.
const JUDGE_MODEL = process.env.MAXX_JUDGE_MODEL || "nvidia/nemotron-3-ultra-550b-a55b:free";

// Harness = which agent CLI a seat runs. opencode is keyless/free. claude and
// codex have no free tier, so — exactly like the single-build terminal path —
// they run under the kimirelay wrapper pointed at the broker relay (OpenRouter
// for claude, Nebius for codex); the seat carries only its relayToken, the real
// key stays on the broker. Those relay keys must be configured for claude/codex
// to actually run; opencode needs nothing.
const HARNESSES = new Set(["opencode", "claude", "codex"]);
const HARNESS_FLAGS = {
  claude: "--dangerously-skip-permissions",
  codex: "--dangerously-bypass-approvals-and-sandbox",
  opencode: "--auto",
};
// Resolved lazily (per request), NOT at module load: maxx.js is imported before
// broker.js parses .env into process.env, so a module-load read would miss
// LLM_PROVIDER_CLAUDE / LLM_PROVIDER_CODEX.
// "aisa" (api.aisa.one) is the default: one OpenAI-compatible gateway fronting
// 100+ models behind a single key, so both harnesses work without per-vendor keys.
// Aisa model per harness (mirrors broker.js; the relay pins it upstream too).
const AISA_MODEL_CLAUDE = process.env.AISA_MODEL_CLAUDE || "claude-sonnet-5";
const AISA_MODEL_CODEX = process.env.AISA_MODEL_CODEX || "gpt-5.3-codex";
const PROVIDERS = new Set(["aisa", "openrouter", "nebius", "opencode"]);
function harnessProvider(harness, pref) {
  if (pref && PROVIDERS.has(pref) && pref !== "opencode") return pref;   // per-run choice wins
  if (harness === "claude") return process.env.LLM_PROVIDER_CLAUDE || process.env.LLM_PROVIDER || "aisa";
  if (harness === "codex") return process.env.LLM_PROVIDER_CODEX || process.env.LLM_PROVIDER || "aisa";
  return null;
}
// Relay upstream key for a harness: aisa is registered per-harness (aisa-claude /
// aisa-codex) so each pins the model its wire format expects.
function relayUpstream(harness, pref) {
  const p = harnessProvider(harness, pref);
  return p === "aisa" ? `aisa-${harness === "codex" ? "codex" : "claude"}` : p;
}

const APP_PORT = 3000;
const DEFAULT_DEADLINE_MS = 30 * 60_000;
const SEAT_STAGGER_MS = 1500;
const JUDGE_MAX_WAIT_MS = 20 * 60_000;   // judge on whatever shipped by here

export function createMaxx({ client, tracked, saveState, indexRelay, log, json, readJson, terminateSession, brokerUrl, opencodeUpgrade = "" }) {
  const DIR = path.dirname(new URL(import.meta.url).pathname);
  // Web search/fetch for seats, via the broker relay (TinyFish free tier). The
  // shim ships into the seat; the real key never leaves the broker. Feature is
  // simply absent when TINYFISH_API_KEY is unset.
  let WEB_MCP_B64 = null;
  try { WEB_MCP_B64 = fs.readFileSync(path.join(DIR, "seat", "websearch-mcp.js"), "utf8"); } catch {}
  const webEnabled = () => !!(process.env.TINYFISH_API_KEY && WEB_MCP_B64);
  const WEB_MCP_PATH = "/home/tenki/.local/bin/websearch-mcp.js";
  const TEAMS_DIR = path.join(DIR, "teams");
  const STATE_FILE = path.join(DIR, "maxx-state.json");

  let runs = {};
  try { runs = JSON.parse(fs.readFileSync(STATE_FILE, "utf8")); } catch {}
  const save = () => fs.writeFileSync(STATE_FILE, JSON.stringify(runs));

  /* Shipped apps, for the homepage wall. EVERY shipped app is recorded here, but
   * only entries an operator sets "featured": true are ever shown: visitors write
   * the prompts and agents build whatever they are asked, so nothing reaches the
   * homepage without a person choosing it. Feature one by editing gallery.json on
   * the host (no restart needed). Featured entries are shown only while their URL
   * still answers, so a dead sandbox never leaves a broken card. */
  const GALLERY_FILE = path.join(DIR, "gallery.json");
  const readGallery = () => { try { return JSON.parse(fs.readFileSync(GALLERY_FILE, "utf8")); } catch { return []; } };
  function recordShipped(r, team, url) {
    const g = readGallery();
    const id = `${r.id}-${team.tag}`;
    if (g.some((e) => e.id === id)) return;
    g.unshift({
      id, url, featured: false, shippedAt: new Date().toISOString(),
      prompt: String(r.prompt || "").slice(0, 240),
      team: team.tag, agents: team.size, harness: r.harness || "opencode", provider: r.provider || null,
    });
    try { fs.writeFileSync(GALLERY_FILE, JSON.stringify(g.slice(0, 200), null, 2)); }
    catch (e) { log("gallery_write_failed", { message: e.message }); }
  }
  const liveCache = new Map();   // url -> { ok, at }
  async function isLive(url) {
    const c = liveCache.get(url);
    if (c && Date.now() - c.at < 5 * 60_000) return c.ok;
    let ok = false;
    try { ok = (await fetch(url, { method: "GET", redirect: "follow", signal: AbortSignal.timeout(4000) })).ok; } catch {}
    liveCache.set(url, { ok, at: Date.now() });
    return ok;
  }
  async function gallery(res) {
    const featured = readGallery().filter((e) => e.featured === true).slice(0, 24);
    const live = (await Promise.all(featured.map(async (e) => ((await isLive(e.url)) ? e : null)))).filter(Boolean);
    return json(res, 200, {
      apps: live.slice(0, 12).map(({ url, prompt, team, agents, harness, shippedAt }) => ({ url, prompt, team, agents, harness, shippedAt })),
    });
  }

  const loadTemplate = (name) => {
    const safe = String(name || "").replace(/[^a-z0-9-]/gi, "");
    if (!safe) return null;
    try { return JSON.parse(fs.readFileSync(path.join(TEAMS_DIR, `${safe}.json`), "utf8")); }
    catch { return null; }
  };
  const listTemplates = () =>
    fs.readdirSync(TEAMS_DIR).filter((f) => f.endsWith(".json")).map((f) => {
      try { const t = JSON.parse(fs.readFileSync(path.join(TEAMS_DIR, f), "utf8"));
            return { name: t.name, description: t.description, seats: t.seats?.length ?? 0 }; }
      catch { return null; }
    }).filter(Boolean);

  // Canonical roster: a team of N takes the first N seats (architect first), so
  // sizes 1/4/12/24 are prefixes. The deploy-page selectors drive this.
  const ROSTER = "full-24";
  const TEAM_SIZES = [1, 4, 12, 24];    // selectable per-team size (solo / 2-team)
  const TAGS = ["A", "B"];              // head-to-head only
  function rosterSeats(n) {
    const t = loadTemplate(ROSTER);
    const seats = (t && t.seats) || [];
    return seats.slice(0, Math.max(1, Math.min(Number(n) || 1, seats.length)));
  }

  // Seat 0 (lead/architect) always gets the strongest model; others round-robin.
  // Frontier: everyone on the one hosted model (relay pins it). offset shifts
  // Team B's free lineup so the two teams differ.
  function assignModels(seats, mode, offset, harness, provider) {
    // claude/codex: the relay pins the model, so every seat is labelled by its
    // harness + upstream (e.g. "claude · openrouter").
    if (harness === "claude" || harness === "codex")
      return seats.map(() => `${harness} · ${harnessProvider(harness, provider)}`);
    if (mode === "frontier") return seats.map(() => `relay/${FRONTIER_MODEL}`);
    const [strong, ...rest] = NATIVE_FREE;
    let i = offset;
    return seats.map((s, idx) =>
      s.model ? s.model
      : idx === 0 || s.modelHint === "strongest" ? strong
      : rest[i++ % rest.length]);
  }

  const token = () => crypto.randomBytes(24).toString("base64url");

  function trackSeat(id) {
    tracked[id] = {
      createdAt: Date.now(), ipHash: "maxx", terminal: null,
      exposeToken: token(), exposeCount: 0,
      relayToken: token(), relayCalls: 0, relayInFlight: 0, maxx: true,
    };
    saveState(); indexRelay();
    return tracked[id];
  }

  // Publish helper (lets a seat expose its OWN app port through the broker).
  function seatEnv(id, entry) {
    const publishHelper =
      "mkdir -p $HOME/.local/bin && cat > $HOME/.local/bin/tenki-publish <<'PUBLISH'\n" +
      "#!/bin/bash\nport=\"${1:?usage: tenki-publish <port>}\"\n" +
      "curl -fsS -X POST \"$TENKI_BROKER_URL/api/demo-sessions/$TENKI_SESSION_ID/expose\" \\\n" +
      "  -H \"x-expose-token: $TENKI_EXPOSE_TOKEN\" -H 'content-type: application/json' \\\n" +
      "  -d \"{\\\"port\\\":$port}\"\nPUBLISH\nchmod +x $HOME/.local/bin/tenki-publish";
    // A server started with a bare `nohup ... &` inside an agent's tool call dies
    // with that call's process group, so the app 502s moments after it publishes.
    // setsid detaches it properly; this helper also waits until the port answers.
    const serveHelper =
      "cat > $HOME/.local/bin/tenki-serve <<'SERVE'\n" +
      "#!/bin/bash\nport=\"${1:-3000}\"; dir=\"${2:-$PWD}\"\n" +
      "pkill -x http.server 2>/dev/null || true\n" +
      "cd \"$dir\" || exit 1\n" +
      "setsid nohup python3 -m http.server \"$port\" --bind 0.0.0.0 </dev/null >/tmp/serve.log 2>&1 &\n" +
      "for i in $(seq 1 25); do sleep 0.4; curl -sf -o /dev/null \"http://127.0.0.1:$port/\" && { echo \"serving $dir on $port\"; exit 0; }; done\n" +
      "echo 'tenki-serve: port did not come up; see /tmp/serve.log' >&2; exit 1\n" +
      "SERVE\nchmod +x $HOME/.local/bin/tenki-serve";
    // The MCP shim reaches the web through the broker relay, so the seat needs
    // its relay token — never the upstream key.
    const webMcp = webEnabled()
      ? [`export TENKI_RELAY_TOKEN='${entry.relayToken}'`,
         `echo ${Buffer.from(WEB_MCP_B64).toString("base64")} | base64 -d > ${WEB_MCP_PATH}`,
         `chmod +x ${WEB_MCP_PATH}`]
      : [];
    return [
      `export TENKI_SESSION_ID='${id}'`,
      `export TENKI_EXPOSE_TOKEN='${entry.exposeToken}'`,
      `export TENKI_BROKER_URL='${brokerUrl}'`,
      'export PATH="$HOME/.local/bin:$PATH"',
      publishHelper,
      serveHelper,
      ...webMcp,
    ];
  }

  // The opencode.json a seat needs: a gortex MCP entry when a repo is indexed,
  // and a relay provider when the seat runs Frontier. Merged into one file.
  function opencodeConfig({ frontier, relayToken, gortex, web }) {
    const cfg = { $schema: "https://opencode.ai/config.json" };
    if (frontier) {
      cfg.provider = { relay: {
        npm: "@ai-sdk/openai-compatible", name: "relay",
        options: { baseURL: `${brokerUrl}/relay/${FRONTIER_PROVIDER}/v1`, apiKey: relayToken },
        models: { [FRONTIER_MODEL]: {} },
      } };
    }
    cfg.mcp = {};
    if (gortex) cfg.mcp.gortex = { type: "local", command: ["gortex", "mcp"], enabled: true };
    if (web) cfg.mcp.websearch = { type: "local", command: ["node", WEB_MCP_PATH], enabled: true };
    if (!Object.keys(cfg.mcp).length) delete cfg.mcp;
    return cfg;
  }

  // Run a shell body HEADLESS: write it to /tmp/work.sh and nohup it (no ttyd,
  // no exposePort → no preview URL). The agent runs to completion unattended.
  async function runHeadless(session, bodyLines) {
    const b64 = Buffer.from(`#!/bin/bash\n${bodyLines.join("\n")}\n`).toString("base64");
    const start =
      `echo ${b64} | base64 -d > /tmp/work.sh; chmod +x /tmp/work.sh; ` +
      `: > /tmp/agent.log; nohup bash /tmp/work.sh >/tmp/agent.log 2>&1 </dev/null & echo STARTED`;
    await session.exec("bash", { args: ["-lc", start], timeoutMs: 20_000 });
  }

  async function launchSeat(run, team, seat, isArchitect) {
    const ttl = Math.max(60_000, run.deadline - Date.now());
    const session = await client.create({
      name: `maxx-${team.tag}-${seat.role}-${crypto.randomBytes(2).toString("hex")}`,
      cpuCores: 1, memoryMb: 1024, allowInbound: true, allowOutbound: true,
      maxDurationMs: ttl, idleTimeoutMinutes: 0,
      metadata: { demo: "true", source: "maxx", maxx: run.id, team: team.tag, role: seat.role },
      waitReady: true,
    });
    const entry = trackSeat(session.id);
    seat.id = session.id;

    const harness = HARNESSES.has(run.harness) ? run.harness : "opencode";
    const isOpencode = harness === "opencode";
    const frontier = run.mode === "frontier";
    const model = seat.model;
    const publishNote = isArchitect
      ? `\n\nWhen the app is ready, publish it with these two commands (in this order):\n  tenki-serve ${APP_PORT} /home/tenki/work\n  tenki-publish ${APP_PORT}\nThen print the URL it returns. Use tenki-serve rather than starting your own background server — a plain \`nohup ... &\` dies with your shell and the published URL then 502s. If the app needs its own runtime (node etc.), start it with \`setsid nohup <cmd> </dev/null >/tmp/serve.log 2>&1 &\` instead, then run tenki-publish ${APP_PORT}.`
      : "";
    const webNote = webEnabled()
      ? "\n\nYou have live web tools via MCP: `web_search` (search the web) and `fetch_url` (read pages as Markdown). Use them to check current docs/APIs rather than guessing from memory."
      : "";
    const repoNote = run.repoUrl
      ? `\n\nThis sandbox is a clone of ${run.repoUrl} (in /home/tenki/work)${isOpencode ? ", indexed by gortex — use the gortex MCP tools to navigate the code instead of reading whole files" : " — read it to ground your work"}.`
      : "";

    // Repo clone (+ gortex index for opencode only — the MCP wiring lives in
    // opencode.json; claude/codex just read the clone directly).
    const setup = run.repoUrl
      ? [
          `git clone --depth 1 ${run.repoUrl} /home/tenki/work 2>/dev/null || mkdir -p /home/tenki/work`,
          "cd /home/tenki/work",
          ...(isOpencode ? [
            "curl -fsSL -o /tmp/g.tgz https://github.com/zzet/gortex/releases/latest/download/gortex_linux_amd64.tar.gz && tar xzf /tmp/g.tgz -C /tmp && (sudo mv /tmp/gortex /usr/local/bin/gortex 2>/dev/null || mv /tmp/gortex $HOME/.local/bin/gortex)",
            "nohup gortex daemon start >/tmp/gortex-daemon.log 2>&1 </dev/null & sleep 2",
            "gortex track /home/tenki/work >/tmp/gortex-track.log 2>&1 || true",
          ] : []),
        ]
      : ["mkdir -p /home/tenki/work && cd /home/tenki/work"];

    // Per-harness launch command (written verbatim into /tmp/agent-cmd.sh via a
    // QUOTED heredoc, so $(cat /tmp/prompt.txt) expands at agent runtime, not now).
    //  • opencode — keyless free models (or relay Frontier model) via opencode.json.
    //  • claude/codex — no free tier, so run under the kimirelay wrapper pointed at
    //    the broker relay (OpenRouter for claude, Nebius for codex). Only the
    //    per-session relayToken enters the VM; the real key stays on the broker.
    let cfgWrite = [];
    let agentCmd;
    if (isOpencode) {
      const cfg = opencodeConfig({ frontier, relayToken: entry.relayToken, gortex: !!run.repoUrl, web: webEnabled() });
      const cfgB64 = Buffer.from(JSON.stringify(cfg, null, 2)).toString("base64");
      cfgWrite = [`echo ${cfgB64} | base64 -d > /home/tenki/work/opencode.json`];
      // Upgrade first: the free tier refuses opencode < 1.18 (see broker.js).
      agentCmd = `${opencodeUpgrade}\nexec opencode --auto --model ${model} --prompt "$(cat /tmp/prompt.txt)"`;
    } else {
      const upstream = relayUpstream(harness, run.provider);
      const usingAisa = harnessProvider(harness, run.provider) === "aisa";
      if (usingAisa && harness === "claude") {
        // Aisa serves the Anthropic wire format natively (/v1/messages), so claude
        // talks to the relay DIRECTLY via ANTHROPIC_BASE_URL — no kimirelay. That
        // wrapper is built for Nebius Token Factory and reshapes the request into
        // a Nebius-specific form, which Aisa rejects ("Input does not match the
        // expected shape"). The seat still only ever holds its relayToken.
        agentCmd = [
          `export ANTHROPIC_BASE_URL='${brokerUrl}/relay/${upstream}'`,
          `export ANTHROPIC_AUTH_TOKEN='${entry.relayToken}'`,
          // ANTHROPIC_API_KEY must be UNSET: the base image ships one, and any
          // value here makes claude stop and ask "use this custom API key?".
          // ANTHROPIC_AUTH_TOKEN alone authenticates without the prompt.
          `unset ANTHROPIC_API_KEY`,
          `export ANTHROPIC_MODEL='${AISA_MODEL_CLAUDE}'`,
          `exec claude ${HARNESS_FLAGS.claude} "$(cat /tmp/prompt.txt)"`,
        ].join("\n");
      } else if (usingAisa && harness === "codex") {
        // Direct: config.toml (seeded above) points codex at our relay.
        // codex otherwise stops at a "Sign in with ChatGPT / provide an API key"
        // gate: it only treats itself as authenticated when an API key is present.
        // auth.json + OPENAI_API_KEY both point at the per-session relay token.
        agentCmd = [
          `export OPENAI_API_KEY='${entry.relayToken}'`,
          `mkdir -p "$HOME/.codex" && printf '%s' '{"OPENAI_API_KEY":"${entry.relayToken}"}' > "$HOME/.codex/auth.json"`,
          `exec codex ${HARNESS_FLAGS.codex} "$(cat /tmp/prompt.txt)"`,
        ].join("\n");
      } else {
        // claude/codex on nebius/openrouter go through kimirelay, which
        // translates their native wire formats to the Nebius-style upstream.
        agentCmd = [
          `export NEBIUS_API_KEY='${entry.relayToken}'`,
          `export NEBIUS_BASE_URL='${brokerUrl}/relay/${upstream}/v1'`,
          `export PATH="$HOME/.kimirelay/bin:$HOME/.local/bin:$PATH"`,
          `command -v kimirelay >/dev/null 2>&1 || { echo "installing kimi-relay…"; curl -fsSL https://kimirelay.com/install.sh | sh >/tmp/kimirelay-install.log 2>&1 || echo "kimi-relay install failed — see /tmp/kimirelay-install.log"; }`,
          `exec kimirelay ${harness} ${HARNESS_FLAGS[harness]} "$(cat /tmp/prompt.txt)"`,
        ].join("\n");
      }
    }

    // claude/codex first-run onboarding blocks headless: claude's theme picker
    // AND its per-folder "do you trust this folder?" dialog both wait for a
    // keypress (the trust dialog isn't covered by --dangerously-skip-permissions).
    // Pre-seed ~/.claude.json with onboarding done + the work dir pre-trusted so
    // the agent goes straight to the task.
    const claudeCfg = JSON.stringify({
      hasCompletedOnboarding: true,
      theme: "dark",
      bypassPermissionsModeAccepted: true,
      projects: { "/home/tenki/work": { hasTrustDialogAccepted: true, projectOnboardingSeenCount: 1, allowedTools: [] } },
      ...(webEnabled()
        ? { mcpServers: { websearch: { command: "node", args: [WEB_MCP_PATH] } } }
        : {}),
    });
    // codex has the SAME class of gate: "Do you trust the contents of this
    // directory?" blocks headless and is NOT covered by
    // --dangerously-bypass-approvals-and-sandbox. Pre-trust the work dir in
    // ~/.codex/config.toml so it goes straight to the task.
    // On aisa, codex ALSO bypasses kimirelay (same reason as claude: that wrapper
    // reshapes into Nebius's form and the response stream fails with
    // "response.failed"). codex speaks the OpenAI Responses API natively, which
    // our relay serves, so point it straight at the relay via a custom provider.
    const codexAisa = harnessProvider("codex", run.provider) === "aisa";
    // TOML: root-level keys MUST come before any [table] header, or they are
    // parsed as members of that table. model_provider/model placed after
    // [projects...] were silently ignored and codex fell back to api.openai.com.
    const codexCfg = [
      ...(codexAisa ? [
        'model_provider = "relay"',
        `model = "${AISA_MODEL_CODEX}"`,
        '',
        '[model_providers.relay]',
        'name = "relay"',
        `base_url = "${brokerUrl}/relay/${relayUpstream("codex", run.provider)}/v1"`,
        'env_key = "OPENAI_API_KEY"',
        'wire_api = "responses"',
        '',
      ] : []),
      ...(webEnabled() ? [
        '[mcp_servers.websearch]',
        'command = "node"',
        `args = ["${WEB_MCP_PATH}"]`,
        '',
      ] : []),
      '[projects."/home/tenki/work"]',
      'trust_level = "trusted"',
    ].join("\n");
    const seedCfg = harness === "claude"
      ? [`printf '%s' '${claudeCfg}' > "$HOME/.claude.json"`]
      : harness === "codex"
      ? [`mkdir -p "$HOME/.codex"`,
         `printf '%s\\n' '${codexCfg}' > "$HOME/.codex/config.toml"`]
      : [];

    const body = [
      ...seatEnv(session.id, entry),
      ...setup,
      ...cfgWrite,
      ...seedCfg,
      `cat > /tmp/prompt.txt <<'PROMPT'\n${seat.duty}\n\nBUILD REQUEST:\n${run.prompt}${repoNote}${webNote}${publishNote}\nPROMPT`,
      // Run the agent's TUI in a detached tmux session (autonomous + attachable),
      // so watch drops into the live agent rather than a log tail.
      `command -v tmux >/dev/null 2>&1 || { sudo apt-get update >/tmp/tmux-install.log 2>&1; sudo apt-get install -y tmux >>/tmp/tmux-install.log 2>&1; }`,
      `cat > /tmp/agent-cmd.sh <<'CMD'\n#!/bin/bash\ncd /home/tenki/work\n${agentCmd}\nCMD`,
      `chmod +x /tmp/agent-cmd.sh`,
      `tmux kill-server 2>/dev/null; tmux new-session -d -s agent -x 220 -y 50 'bash /tmp/agent-cmd.sh'`,
      `echo "[maxx] ${harness} running in tmux session 'agent' — watch attaches to the live TUI"`,
    ];
    await runHeadless(session, body);
    seat.state = "running"; seat.terminalUrl = null;
    save();
  }

  async function launchRun(run) {
    const seatFail = (team, seat, e) => {
      seat.state = "failed"; seat.error = e.message; save();
      log("maxx_seat_failed", { runId: run.id, team: team.tag, role: seat.role, message: e.message });
    };
    try {
      // Fair start: every team's architect (seat 0) launches at the same time,
      // so no team gets a head start in the arena.
      await Promise.all(run.teams.map((team) =>
        team.seats.length
          ? launchSeat(run, team, team.seats[0], true).catch((e) => seatFail(team, team.seats[0], e))
          : Promise.resolve()));
      // Remaining seats, staggered and interleaved across teams (column by
      // column) so a large team doesn't monopolize the early launches.
      const maxLen = Math.max(0, ...run.teams.map((t) => t.seats.length));
      for (let k = 1; k < maxLen; k++) {
        for (const team of run.teams) {
          if (k >= team.seats.length) continue;
          if (run.aborted) { log("maxx_launch_aborted", { runId: run.id }); return; }
          try { await launchSeat(run, team, team.seats[k], false); }
          catch (e) { seatFail(team, team.seats[k], e); }
          await new Promise((r) => setTimeout(r, SEAT_STAGGER_MS));
        }
      }
      if (!run.aborted) {
        run.state = "running"; save();
        log("maxx_launched", { runId: run.id, teams: run.teams.length, seats: run.teams.reduce((n, t) => n + t.seats.length, 0) });
        if (run.compete) setTimeout(() => judge(run, true).catch(() => {}), JUDGE_MAX_WAIT_MS);
      }
    } catch (e) {
      run.state = "failed"; run.error = e.message; save();
      log("maxx_launch_failed", { runId: run.id, message: e.message });
    }
  }

  /* Broker-side judge — no sandbox. When both teams have shipped (or the max
   * wait elapses), fetch both apps and score them with a free model directly.
   * The broker holds the key, so this costs nothing and needs no VM. */
  async function judge(run, force) {
    if (run.verdict || run.judging || !run.compete) return;
    const shipped = run.teams.filter((t) => t.publishedUrl);
    if (!force && shipped.length < run.teams.length) return;   // wait for both
    if (shipped.length === 0) return;
    if (!process.env.OPENROUTER_API_KEY) return;
    run.judging = true; save();
    try {
      const perTeam = run.teams.length > 2 ? 2200 : 3200;
      const htmls = await Promise.all(run.teams.map(async (t) => {
        if (!t.publishedUrl) return "(no build shipped)";
        try { const r = await fetch(t.publishedUrl, { signal: AbortSignal.timeout(8000) }); return (await r.text()).slice(0, perTeam); }
        catch { return "(build unreachable)"; }
      }));
      const letters = run.teams.map((t) => t.tag);
      const blocks = run.teams.map((t, i) =>
        `TEAM ${t.tag} — ${t.size ?? t.seats.length} agent${(t.size ?? t.seats.length) === 1 ? "" : "s"} — ${t.publishedUrl || "did not ship"}:\n${htmls[i]}`
      ).join("\n\n");
      const prompt =
        `Judge these ${run.teams.length} builds for the brief:\n"${run.prompt}"\n\n${blocks}\n\n` +
        `Judge only on the result, not the team size. Which one best fulfils the brief and looks like it actually works? ` +
        `First line EXACTLY "WINNER: X" where X is one of: ${letters.join(", ")}. Then one sentence why.`;
      const rr = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: { authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`, "content-type": "application/json" },
        body: JSON.stringify({ model: JUDGE_MODEL, max_tokens: 260, messages: [{ role: "user", content: prompt }] }),
        signal: AbortSignal.timeout(60_000),
      });
      const jd = await rr.json();
      const text = (jd.choices?.[0]?.message?.content || "").trim();
      const m = new RegExp(`WINNER:\\s*([${letters.join("")}])`, "i").exec(text);
      run.verdict = {
        winner: m ? m[1].toUpperCase() : null,
        reasoning: text.replace(/^\s*WINNER:\s*[A-D]\.?\s*/i, "").trim().slice(0, 500),
        at: Date.now(),
      };
      save(); log("maxx_judged", { runId: run.id, winner: run.verdict.winner });
    } catch (e) {
      run.verdict = { winner: null, reasoning: "Judge unavailable.", at: Date.now() };
      save(); log("maxx_judge_failed", { runId: run.id, message: e.message });
    } finally {
      run.judging = false; save();
    }
  }

  const publicRun = (r) => ({
    id: r.id, template: r.template, state: r.state, mode: r.mode, compete: r.compete,
    harness: r.harness ?? "opencode", provider: r.provider ?? null,
    round: r.round ?? 1, pickedWinner: r.pickedWinner ?? null,
    deadline: r.deadline, prompt: r.prompt, repoUrl: r.repoUrl ?? null, error: r.error ?? null,
    verdict: r.verdict ?? null,
    teams: r.teams.map((t) => ({
      tag: t.tag, size: t.size ?? t.seats.length, publishedUrl: t.publishedUrl ?? null,
      seats: t.seats.map((s) => ({ role: s.role, model: s.model, state: s.state, terminalUrl: s.terminalUrl ?? null })),
    })),
  });

  function cleanRepoUrl(raw) {
    if (typeof raw !== "string" || !raw.trim()) return null;
    let u; try { u = new URL(raw.trim()); } catch { return null; }
    if (u.protocol !== "https:" || u.username || u.password) return null;
    return u.href.replace(/\.git$/, "") + ".git";
  }

  async function start(req, res) {
    const body = await readJson(req);
    const prompt = typeof body.prompt === "string" ? body.prompt.slice(0, 4000) : "";
    if (!prompt) return json(res, 400, { error: "prompt_required" });
    const mode = body.mode === "frontier" ? "frontier" : "free";
    const harness = HARNESSES.has(body.harness) ? body.harness : "opencode";
    // Preferred provider (aisa|openrouter|nebius|opencode). "opencode" means the
    // keyless native models, which only the opencode harness can serve.
    const provider = PROVIDERS.has(body.provider) ? body.provider : "aisa";
    const repoUrl = body.repo ? cleanRepoUrl(body.repo) : null;
    if (body.repo && !repoUrl) return json(res, 400, { error: "bad_repo", note: "public https git URL only" });
    // claude/codex and opencode-frontier all route through the broker relay, which
    // needs an https public URL to hand the seat.
    if ((mode === "frontier" || harness !== "opencode") && !/^https:\/\//.test(brokerUrl))
      return json(res, 501, { error: "relay_unconfigured" });
    // claude/codex have no free tier — the broker relay needs the upstream key.
    // Fail early with a clear message rather than launching seats that silently
    // can't reach a model.
    if (harness !== "opencode") {
      const KEY_VAR = { aisa: "AISA_API_KEY", openrouter: "OPENROUTER_API_KEY", nebius: "NEBIUS_API_KEY" };
      const keyVar = KEY_VAR[harnessProvider(harness, provider)] || "AISA_API_KEY";
      if (!process.env[keyVar]) return json(res, 501, { error: "harness_unconfigured", harness, need: keyVar });
    }

    // Resolve the team layout. Two ways in:
    //  • new deploy API — { teams: 1|2|4, size: 1|4|12 }. 4 = asymmetric arena
    //    (sizes 1/4/12/24). `layout` is one seat-def array per team.
    //  • legacy — a named { team } template, optionally { compete } for 2 teams.
    let layout, label;
    const legacy = body.team ? loadTemplate(body.team) : null;
    if (body.team && !legacy)
      return json(res, 400, { error: "unknown_team", have: listTemplates().map((t) => t.name) });
    if (legacy) {
      const n = body.compete === true ? 2 : 1;
      layout = Array.from({ length: n }, () => legacy.seats);
      label = legacy.name;
    } else {
      const teamsReq = [1, 2].includes(Number(body.teams)) ? Number(body.teams) : 1;
      const size = TEAM_SIZES.includes(Number(body.size)) ? Number(body.size) : 4;
      layout = Array.from({ length: teamsReq }, () => rosterSeats(size));
      label = teamsReq > 1 ? `arena-${teamsReq} · ${size} each` : `solo · ${size}`;
    }
    const teamCount = layout.length;
    const compete = teamCount > 1;
    const totalSeats = layout.reduce((n, s) => n + s.length, 0);

    // Capacity: seats need one VM each (max_concurrent_jobs); each team ships one
    // app = one preview URL. Check both, leaving headroom for other traffic.
    let vmMax = 100, vmUsed = 0, previewMax = 100, previewUsed = 0;
    try {
      const usage = await client.getUsage();
      const vm = usage.find((x) => x.key === "max_concurrent_jobs");
      const pv = usage.find((x) => x.key === "preview_urls_per_workspace");
      if (vm) { vmMax = vm.max ?? vmMax; vmUsed = vm.current ?? 0; }
      if (pv) { previewMax = pv.max ?? previewMax; previewUsed = pv.current ?? 0; }
    } catch {}
    // Headroom so an arena run cannot consume the whole workspace. A FLAT
    // reservation sized for a 100-slot workspace swallows a small one entirely:
    // at vmMax 5 the old `|| 5` left free = 5 - used - 5, i.e. zero capacity even
    // with nothing running, so every run failed with "needs N, only 0 available".
    // Never reserve more than half the quota.
    // Scale to a quarter of the quota so a big workspace keeps the full flat
    // reservation (vmMax 100 -> 5, unchanged) while a small one keeps at most 1.
    const headroom = (cfg, max) => Math.min(cfg, Math.max(1, Math.floor(max / 4)));
    const VM_RESERVED = headroom(Number(process.env.MAXX_RESERVED_VMS || 5), vmMax);
    const PV_RESERVED = headroom(Number(process.env.MAXX_RESERVED_PREVIEWS || 3), previewMax);
    if (totalSeats > vmMax - vmUsed - VM_RESERVED)
      return json(res, 503, { error: "capacity", kind: "vms", need: totalSeats, free: Math.max(0, vmMax - vmUsed - VM_RESERVED), vmMax, vmUsed, note: "one sandbox per agent" });
    if (teamCount > previewMax - previewUsed - PV_RESERVED)
      return json(res, 503, { error: "capacity", kind: "previews", need: teamCount, free: Math.max(0, previewMax - previewUsed - PV_RESERVED), previewMax, previewUsed, note: "each team ships one app (one preview URL)" });

    const mkTeam = (seatDefs, idx) => ({
      tag: TAGS[idx], size: seatDefs.length, publishedUrl: null,
      seats: assignModels(seatDefs, mode, idx * 2, harness, provider).map((model, i) => ({
        role: seatDefs[i].role, duty: seatDefs[i].duty, model,
        state: "pending", id: null, terminalUrl: null,
      })),
    });
    const runId = crypto.randomBytes(6).toString("hex");
    runs[runId] = {
      id: runId, template: label, prompt, repoUrl, mode, compete, harness, provider,
      state: "launching", createdAt: Date.now(), deadline: Date.now() + DEFAULT_DEADLINE_MS,
      verdict: null,
      teams: layout.map(mkTeam),
    };
    save();
    launchRun(runs[runId]).catch((e) => log("maxx_bg_failed", { runId, message: e.message }));
    return json(res, 201, publicRun(runs[runId]));
  }

  async function get(res, runId) {
    const r = runs[runId];
    return r ? json(res, 200, publicRun(r)) : json(res, 404, { error: "not_found" });
  }

  // Stop the run's agents. By default the shipped deliverable(s) are KEPT alive
  // — stopping the agents shouldn't destroy the end product. `releaseAll` also
  // tears the deliverables down (full cleanup).
  async function stop(res, runId, releaseAll) {
    const r = runs[runId];
    if (!r) return json(res, 404, { error: "not_found" });
    r.aborted = true;
    const kept = [];
    const toKill = [];
    for (const team of r.teams) for (const s of team.seats) {
      if (!s.id) continue;
      if (s.published && !releaseAll) { s.state = "shipped"; if (team.publishedUrl) kept.push(team.publishedUrl); continue; }
      toKill.push(s.id);
      s.state = "stopped";        // reflect immediately so the UI count is right
      delete tracked[s.id];
    }
    r.state = releaseAll ? "released" : "stopped";
    save(); saveState(); indexRelay();
    // Terminate in the BACKGROUND — paused seats need resume+close, which is
    // slow; blocking the response is what hung the "Stop all" button.
    (async () => { for (const id of toKill) await terminateSession(id); })()
      .catch((e) => log("maxx_stop_kill_failed", { runId, message: e.message }));
    log("maxx_stopped", { runId, kept: kept.length, killing: toKill.length, releaseAll: !!releaseAll });
    return json(res, 200, { ok: true, kept });
  }

  // Periodic: end runs past their deadline (agents auto-pause then, but the run
  // state would otherwise show "running" forever). Terminate worker seats, keep
  // shipped ones. Called from the broker's reaper loop.
  async function sweep() {
    for (const r of Object.values(runs)) {
      if (r.state !== "running" && r.state !== "launching") continue;
      if (Date.now() < r.deadline) continue;
      const toKill = [];
      for (const team of r.teams) for (const s of team.seats) {
        if (s.published) { s.state = "shipped"; continue; }
        if (s.id) { toKill.push(s.id); delete tracked[s.id]; }
        s.state = "ended";
      }
      r.state = "ended";
      save(); saveState(); indexRelay();
      log("maxx_run_ended", { runId: r.id, terminated: toKill.length });
      for (const id of toKill) await terminateSession(id);
    }
  }

  // On-demand watch: start a ttyd tailing this seat's agent log and expose it,
  // so a preview URL is spent only on seats someone actually opens. The browser
  // never learns seat session ids — it addresses a seat by {team, role}.
  async function watch(req, res, runId) {
    const r = runs[runId];
    if (!r) return json(res, 404, { error: "not_found" });
    const body = await readJson(req);
    let seat = null;
    for (const t of r.teams) if (t.tag === body.team) { seat = t.seats.find((s) => s.role === body.role); break; }
    if (!seat || !seat.id) return json(res, 404, { error: "seat_not_found" });
    if (seat.terminalUrl && seat.watchExpires > Date.now() + 60_000)
      return json(res, 200, { url: seat.terminalUrl });
    try {
      const s = await client.get(seat.id);
      if (s.state !== "RUNNING") return json(res, 409, { error: "not_running", state: s.state });
      const t = crypto.randomBytes(16).toString("base64url");
      // Attach (read-only) to the agent's tmux session, so the viewer sees the
      // live opencode TUI. pkill -x (exact NAME) — never -f, which would match
      // this shell's own command line and self-kill the exec.
      const start =
        `pkill -x ttyd 2>/dev/null; sleep 0.2; ` +
        // NOT `attach -r`: read-only was the old behaviour and meant viewers
        // could watch but never steer. ttyd already runs writable (-W), so
        // dropping -r lets a human type straight into the agent's session.
        `nohup ttyd -p 8080 -W -b /t-${t} bash -lc ` +
        `'tmux attach -t agent 2>/dev/null || { echo; echo "  agent not attached — the run is still starting or has finished."; sleep 4; }' ` +
        `>/tmp/ttyd.log 2>&1 </dev/null & ` +
        `sleep 0.4; curl -sf -o /dev/null http://127.0.0.1:8080/t-${t}/ && echo OK`;
      await s.exec("bash", { args: ["-lc", start], timeoutMs: 15_000 });
      const ttl = Math.max(60_000, r.deadline - Date.now());
      const exposed = await s.exposePort(8080, { ttlMs: ttl });
      seat.terminalUrl = `${exposed.previewUrl.replace(/\/$/, "")}/t-${t}/`;
      seat.watchExpires = exposed.expiresAt ? new Date(exposed.expiresAt).getTime() : Date.now() + ttl;
      save();
      log("maxx_watch", { runId, team: body.team, role: body.role });
      return json(res, 200, { url: seat.terminalUrl });
    } catch (e) {
      // exposePort throws when the 20-preview-URL cap is hit — surface it kindly.
      if (/preview|quota|limit/i.test(e.message || "")) return json(res, 503, { error: "preview_limit" });
      log("maxx_watch_failed", { runId, role: body.role, message: e.message });
      return json(res, 502, { error: "watch_failed" });
    }
  }

  // Send a line of text to a seat's agent, as if typed at its prompt. Text is
  // base64'd so no shell/tmux quoting can bite, and `send-keys -l` is literal so
  // words like "Enter" are not interpreted as key names.
  async function say(req, res, runId) {
    const r = runs[runId];
    if (!r) return json(res, 404, { error: "not_found" });
    const body = await readJson(req);
    const text = typeof body.text === "string" ? body.text.slice(0, 4000) : "";
    if (!text.trim()) return json(res, 400, { error: "text_required" });
    let seat = null;
    for (const t of r.teams) if (t.tag === body.team) { seat = t.seats.find((x) => x.role === body.role); break; }
    if (!seat || !seat.id) return json(res, 404, { error: "seat_not_found" });
    try {
      const s = await client.get(seat.id);
      if (s.state !== "RUNNING") return json(res, 409, { error: "not_running", state: s.state });
      await typeToAgent(s, text);
      log("maxx_say", { runId, team: body.team, role: body.role, chars: text.length });
      return json(res, 200, { ok: true });
    } catch (e) {
      log("maxx_say_failed", { runId, role: body.role, message: e.message });
      return json(res, 502, { error: "say_failed" });
    }
  }

  // Type a line into a seat's running agent (base64 so nothing can be mangled by
  // shell or tmux quoting; -l is literal so words like "Enter" stay text).
  async function typeToAgent(session, text) {
    const b64 = Buffer.from(text).toString("base64");
    await session.exec("bash", {
      args: ["-lc",
        `T=$(echo ${b64} | base64 -d); tmux send-keys -t agent -l "$T" && tmux send-keys -t agent Enter && echo SENT`],
      timeoutMs: 20_000,
    });
  }

  /* Pick a winning team and start another round: the winner's code becomes the
   * shared starting point (losers' work is replaced by it), then EVERY seat is
   * told to improve it, optionally steered by the user's feedback. The winner
   * keeps iterating too, so the round is winner-vs-itself-plus-rivals. */
  async function pick(req, res, runId) {
    const r = runs[runId];
    if (!r) return json(res, 404, { error: "not_found" });
    const body = await readJson(req);
    const tag = String(body.winner || "").toUpperCase();
    const feedback = typeof body.feedback === "string" ? body.feedback.slice(0, 2000).trim() : "";
    const winner = r.teams.find((t) => t.tag === tag);
    if (!winner) return json(res, 400, { error: "unknown_team", have: r.teams.map((t) => t.tag) });
    const source = winner.seats[0];                       // architect holds the canonical build
    if (!source || !source.id) return json(res, 409, { error: "no_source_seat" });
    if (r.picking) return json(res, 409, { error: "already_picking" });
    r.picking = true; save();
    try {
      const src = await client.get(source.id);
      if (src.state !== "RUNNING") return json(res, 409, { error: "not_running", state: src.state });
      // Snapshot the winner's working tree.
      const out = await src.exec("bash", {
        args: ["-lc", "cd /home/tenki/work 2>/dev/null && tar czf - --exclude=node_modules --exclude=.git . 2>/dev/null | base64 -w0"],
        timeoutMs: 90_000,
      });
      const b64 = (stdoutText(out) || "").trim();
      if (!b64) return json(res, 409, { error: "empty_workdir", note: "the winning team has not written any files yet" });
      if (b64.length > 1_500_000) return json(res, 413, { error: "workdir_too_large" });

      const targets = [];
      for (const team of r.teams) for (const seat of team.seats) {
        if (!seat.id || seat.id === source.id) continue;
        targets.push({ team, seat });
      }
      // Replace every other seat's tree with the winner's.
      let copied = 0;
      await Promise.all(targets.map(async ({ seat }) => {
        try {
          const t = await client.get(seat.id);
          if (t.state !== "RUNNING") return;
          await t.exec("bash", {
            args: ["-lc",
              `mkdir -p /home/tenki/work && rm -rf /home/tenki/work/* /home/tenki/work/.[!.]* 2>/dev/null; ` +
              `echo ${b64} | base64 -d | tar xzf - -C /home/tenki/work && echo COPIED`],
            timeoutMs: 90_000,
          });
          copied++;
        } catch (e) { log("maxx_pick_copy_failed", { runId, role: seat.role, message: e.message }); }
      }));

      // Tell every live seat to iterate on the shared base.
      const round = (r.round || 1) + 1;
      const note =
        `ROUND ${round}. Team ${tag}'s build was chosen as the current best and is now in /home/tenki/work ` +
        `(your previous work there has been replaced). Improve it — make it genuinely better, not merely different. ` +
        (feedback ? `The user's feedback: "${feedback}". Address it directly. ` : "") +
        `When it is ready, run: tenki-serve ${APP_PORT} /home/tenki/work then tenki-publish ${APP_PORT}, and print the URL.`;
      let told = 0;
      await Promise.all(r.teams.flatMap((team) => team.seats.map(async (seat) => {
        if (!seat.id) return;
        try {
          const t = await client.get(seat.id);
          if (t.state !== "RUNNING") return;
          await typeToAgent(t, note);
          told++;
        } catch (e) { log("maxx_pick_tell_failed", { runId, role: seat.role, message: e.message }); }
      })));

      // New round: clear last round's verdict/publications so the UI reflects it.
      r.round = round;
      r.pickedWinner = tag;
      r.verdict = null;
      for (const team of r.teams) { team.publishedUrl = null; for (const seat of team.seats) if (seat.state === "shipped") seat.state = "running"; }
      r.deadline = Math.max(r.deadline, Date.now() + DEFAULT_DEADLINE_MS);
      save();
      log("maxx_picked", { runId, winner: tag, round, copied, told, feedback: !!feedback });
      return json(res, 200, { ok: true, round, winner: tag, copied, told });
    } catch (e) {
      log("maxx_pick_failed", { runId, message: e.message });
      return json(res, 502, { error: "pick_failed", message: e.message });
    } finally {
      r.picking = false; save();
    }
  }

  const templates = (res) => json(res, 200, { templates: listTemplates() });

  // Called by the broker when a sandbox exposes a port: record the shipped app
  // as its team's deliverable, then judge once both teams are in.
  function notifyExpose(sessionId, port, url) {
    if (port === 8080) return;   // ttyd viewer, not the app
    for (const r of Object.values(runs)) {
      for (const team of r.teams || []) {
        const seat = team.seats.find((s) => s.id === sessionId);
        if (seat) {
          team.publishedUrl = url;
          seat.published = true;
          // The shipped app is the deliverable — keep this sandbox alive past
          // the run deadline and exempt it from the reaper, so the end product
          // doesn't turn to sand. Worker seats still expire normally.
          if (tracked[sessionId]) { tracked[sessionId].keep = true; saveState(); }
          client.updateSession(sessionId, { sticky: true })
            .catch((e) => log("maxx_keep_failed", { id: sessionId, message: e.message }));
          save();
          log("maxx_published", { runId: r.id, team: team.tag, url, kept: true });
          recordShipped(r, team, url);
          if (r.compete) judge(r, false).catch(() => {});
          return;
        }
      }
    }
  }

  return { start, get, stop, templates, watch, say, pick, notifyExpose, sweep, gallery };
}
