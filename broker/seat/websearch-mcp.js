#!/usr/bin/env node
/* Stdio MCP server giving a seat's agent live web search + page fetch.
 *
 * Backed by TinyFish (free tier), reached through the broker's /relay proxy so
 * the real TINYFISH_API_KEY never enters the sandbox — the seat carries only its
 * per-session relayToken, exactly like the model relay.
 *
 * Env: TENKI_BROKER_URL, TENKI_RELAY_TOKEN.
 * Protocol: JSON-RPC 2.0, newline-delimited, over stdin/stdout.
 */
const BROKER = (process.env.TENKI_BROKER_URL || "").replace(/\/$/, "");
const TOKEN = process.env.TENKI_RELAY_TOKEN || "";

const TOOLS = [
  {
    name: "web_search",
    description:
      "Search the live web and get ranked results with titles, URLs and snippets. Use for current information, library/API docs, prior art, or anything outside your training data.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "The search query." },
        max_results: { type: "number", description: "How many results to return (1-10, default 5)." },
      },
      required: ["query"],
    },
  },
  {
    name: "fetch_url",
    description:
      "Fetch one or more web pages and return their content as clean Markdown. Use after web_search to read a promising result, or to read a known URL (docs, README, spec).",
    inputSchema: {
      type: "object",
      properties: {
        urls: { type: "array", items: { type: "string" }, description: "Up to 10 URLs to fetch." },
      },
      required: ["urls"],
    },
  },
];

const send = (m) => process.stdout.write(JSON.stringify(m) + "\n");
const ok = (id, result) => send({ jsonrpc: "2.0", id, result });
const err = (id, code, message) => send({ jsonrpc: "2.0", id, error: { code, message } });
const guard = () => { if (!BROKER || !TOKEN) throw new Error("web tools are not configured for this sandbox"); };

async function call(path, init) {
  guard();
  const r = await fetch(`${BROKER}/relay/${path}`, {
    ...init,
    headers: { authorization: `Bearer ${TOKEN}`, ...(init.headers || {}) },
    signal: AbortSignal.timeout(45_000),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`${r.status}: ${text.slice(0, 300)}`);
  try { return JSON.parse(text); } catch { return text; }
}

async function webSearch({ query, max_results }) {
  const n = Math.min(Math.max(Number(max_results) || 5, 1), 10);
  const d = await call(`tinyfish-search?query=${encodeURIComponent(String(query || ""))}`, { method: "GET" });
  if (typeof d === "string") return d.slice(0, 12000);
  const results = d.results || d.data || (Array.isArray(d) ? d : []);
  const out = [];
  if (d.answer) out.push(`ANSWER: ${d.answer}\n`);
  for (const x of results.slice(0, n)) {
    const title = x.title || x.name || "(untitled)";
    const url = x.url || x.link || "";
    const body = x.content || x.snippet || x.description || "";
    out.push(`## ${title}\n${url}\n${String(body).slice(0, 900)}\n`);
  }
  return out.join("\n").slice(0, 12000) || "No results.";
}

async function fetchUrl({ urls }) {
  const list = (Array.isArray(urls) ? urls : [urls]).filter(Boolean).slice(0, 10);
  if (!list.length) throw new Error("urls is required");
  const d = await call("tinyfish-fetch", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ urls: list }),
  });
  if (typeof d === "string") return d.slice(0, 20000);
  const pages = d.results || d.pages || d.data || (Array.isArray(d) ? d : [d]);
  return pages
    .map((p) => `# ${p.url || p.link || ""}\n\n${String(p.markdown || p.content || p.text || "").slice(0, 8000)}`)
    .join("\n\n---\n\n")
    .slice(0, 20000) || "No content.";
}

let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", async (chunk) => {
  buf += chunk;
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    let msg; try { msg = JSON.parse(line); } catch { continue; }
    const { id, method, params } = msg;
    if (id === undefined || id === null) continue;      // notification
    try {
      if (method === "initialize") {
        ok(id, {
          protocolVersion: params?.protocolVersion || "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: "tenki-web", version: "1.0.0" },
        });
      } else if (method === "tools/list") {
        ok(id, { tools: TOOLS });
      } else if (method === "tools/call") {
        const name = params?.name;
        const args = params?.arguments || {};
        try {
          const text = name === "web_search" ? await webSearch(args)
                     : name === "fetch_url"  ? await fetchUrl(args)
                     : null;
          if (text === null) { err(id, -32602, `unknown tool: ${name}`); continue; }
          ok(id, { content: [{ type: "text", text }] });
        } catch (e) {
          ok(id, { content: [{ type: "text", text: `${name} error: ${e.message}` }], isError: true });
        }
      } else if (method === "ping") {
        ok(id, {});
      } else {
        err(id, -32601, `method not found: ${method}`);
      }
    } catch (e) { err(id, -32603, e.message); }
  }
});
process.stdin.on("end", () => process.exit(0));
