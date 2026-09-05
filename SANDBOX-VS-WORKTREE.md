# Sandboxes vs. git worktrees — evidence brief

_32 sources, each independently fact-checked (URL re-opened, quote matched verbatim, attribution corrected). 2 rejected._

# Evidence brief: isolated sandboxes vs. git worktrees for AI coding agents

*All citations verified. Where an argument lacks support, it says so.*

---

## 1. The strongest citable claims

### (a) Safety / blast radius — **strongest leg by far**

| Claim | Source |
|---|---|
| Sandboxing is the only credible answer for agents run with permissions skipped | Simon Willison, *Living dangerously with Claude*, 2025-10-22 |
| YOLO mode's three concrete risks — destructive shell commands, exfiltration of visible files and secrets, and your machine being used to attack others — with only three options: a secure sandbox, someone else's computer, or accepting local risk | Simon Willison, *Designing agentic loops*, 2025-09-30 |
| Any agent holding private data + untrusted content + an outbound channel can be turned against you; the defense is removing a leg, usually egress | Simon Willison, *The lethal trifecta*, 2025-06-16 |
| Blast radius is the reason to containerize, and riskier tasks go to remote machines so the worst case is leaked source on someone else's box | Simon Willison, *Embracing the parallel coding agent lifestyle*, 2025-10-05 |
| Anthropic's own doc **requires** container/VM/sandbox-runtime for bypassed-permission sessions, because a Bash-only sandbox leaves MCP servers and hooks running unconstrained on the host | Anthropic, *Choose a sandbox environment* |
| Containment belongs at the environment layer, not the model layer; egress controls hold when model-level defenses don't | McGuinness, Grace, De Jonghe, Eaton, Ribbink (Anthropic), *How we contain Claude across products*, 2026-05-25 |
| Sandboxing = two OS boundaries (filesystem + network); Anthropic reports an 84% reduction in permission prompts internally | Dworken & Weller-Davies (Anthropic), *Making Claude Code more secure and autonomous with sandboxing*, 2025-10-20 |
| Prompt injection → RCE is demonstrated, not theoretical, via argument injection against *pre-approved* commands — i.e. it defeats the human-approval gate | Will Vandevanter, Trail of Bits, 2025-10-22 |
| Measured attack success rates up to 84% for executing malicious commands against real high-privilege editors (Copilot, Cursor), 314 payloads mapped to MITRE ATT&CK | Liu, Zhao, Lyu, Zhang, Wang, Lo, *"Your AI, My Shell"*, arXiv 2509.22040 |
| Neither prompt-injection attacks nor defenses are solved; 97 tasks / 629 security cases | Debenedetti et al. (ETH Zurich SPY Lab), *AgentDojo*, NeurIPS 2024 |

**The single best worktree-specific fact for this argument** comes from Anthropic's own worktree docs: worktrees still share the repo's `.git` directory, project-scope plugins, **and saved permission approvals** with the main checkout. That is Anthropic conceding, in writing, that a worktree is not a security boundary even inside Claude Code's own permission model.

*Note two different 84% figures above — permission-prompt reduction (Anthropic) and attack success rate (arXiv). Do not let them blur together on a slide.*

### (b) Isolation of shared state — **strongest leg on the worktree-failure side**

The evidence here is almost entirely a catalogue of what worktrees *don't* isolate, which is exactly what you want:

- **Anthropic, *Run parallel sessions with worktrees***: a worktree is a fresh checkout, so `.env`/`.env.local` are simply absent (hence the `.worktreeinclude` workaround); dependencies don't exist until you re-run setup per worktree; Git LFS files arrive as pointer files when LFS was installed `--local`; hook paths don't follow the worktree (`${CLAUDE_PROJECT_DIR}` stays pinned to the main checkout while `cwd` moves).
- **Dave Schumaker, 2026-03-13** — the best-documented cost: a Yarn-workspaces monorepo with 750,000+ files in `node_modules`, ~10 minutes of `yarn install --immutable` per `git worktree add`, for what may be a 5-minute Claude Code task. Symlinked `node_modules` broke Node resolution; `nmMode: hardlinks-global` still created 750K entries; APFS copy-on-write still created every directory entry. His fix is a pool of 6 pre-warmed recycled worktree slots.
- **Scott Chacon (GitHub co-founder, Pro Git author), GitButler, 2025-07-22** — names the two structural costs in one breath: per-worktree bootstrap, and self-inflicted merge conflicts with nothing warning you that two worktrees are editing the same files.
- **Hacker News thread 47866750 (2026-04-22, 279 pts)** — unsolicited practitioner pain, no product being sold: secrets not copying and ports conflicting, ending in a pile of separate DBs and services (Atotalnoob); port conflicts specifically with Docker projects (shmoogy); test-data isolation as the outright blocker, with per-branch Postgres schemas working but "reasoning about which agent broke the shared migration when three of them touch it got old fast" (kippinsula); lifecycle hooks cloning dev+test Postgres per worktree (jamie_ca).
- **The affirmative side**: Replit is the only source that isolates *state* rather than just files — isolated forks of both code **and** database (Brewster & Chávez, 2025-12-17). Cursor, Google (Jules) and Cognition (Devin) each give an agent a whole VM with a full dev environment, which implies its own ports and services, though none of them phrase it as solving port conflicts.

### (c) Parallelism at scale — **well-sourced but all vendor-primary**

- **Cursor**: agents run in isolated cloud VMs with full dev environments; the payoff named in their own docs is unbounded parallelism, no local internet needed.
- **Google Labs (Kathy Korevec), 2025-05-20**: Jules clones the codebase into a secure Google Cloud VM; tasks run in a cloud VM, "enabling concurrent execution."
- **Cognition, 2026-03-19**: each managed Devin gets its own isolated VM, terminal, browser and dev environment — and the stated reason is **context hygiene**, not only security: context accumulates, focus degrades, each sub-agent gets a clean slate and its own test runner. (Devin 2.0, 2025-04-03, already shipped parallel Devins with per-agent cloud IDEs.)
- **Replit**: multiple environments in parallel, several agents attacking the same problem — framed as inference-time scaling via Parallel Sampling.
- **Anthropic multi-agent research system (Hadfield et al., 2025-06-13)**: use for the *isolated-context* pattern only. It makes **no** sandboxing or containment claims. Do not stretch it.

### (d) Reproducibility — **the thinnest leg; see §3**

- **SWE-bench (Jimenez et al., Princeton)** requires models to interact with execution environments, which is what forces a containerized harness at all.
- **Epoch AI (Tom Adamczewski, 2025-07-10)** is the concrete operational proof: a three-tier Docker hierarchy (base → per-repo → **one image per GitHub issue**), 684 GiB of images compressed to 67 GiB by layer reuse, SWE-bench Verified in 62–73 minutes on one machine. This is "one container per unit of work" as real practice, with real numbers on both sides of the ledger.
- **Anthropic devcontainer docs**: the reference container = CLI + `init-firewall.sh` default-deny egress (needs `NET_ADMIN`/`NET_RAW`) + persistent volumes + non-root user, and that combination is what makes unattended runs viable.

---

## 2. The most quotable lines

1. **"The only solution that's credible is to run coding agents in a sandbox."** — Simon Willison, https://simonwillison.net/2025/Oct/22/living-dangerously-with-claude/
2. **"The most effective defense available today is sandboxing: isolating agent operations from the host system."** — Will Vandevanter, Trail of Bits, https://blog.trailofbits.com/2025/10/22/prompt-injection-to-rce-in-ai-agents/
3. **"The only defense that holds in this situation is the environment, specifically egress controls that block the POST regardless of intent."** — Anthropic, https://www.anthropic.com/engineering/how-we-contain-claude
4. **"Always run `--dangerously-skip-permissions` sessions inside a container, a VM, or the sandbox runtime"** — Anthropic docs, https://code.claude.com/docs/en/sandbox-environments
5. **"I need to start habitually running my local agents in Docker containers to further limit the blast radius if something goes wrong."** — Simon Willison, https://simonwillison.net/2025/Oct/5/parallel-coding-agents/
6. **"attack success rates can reach as high as 84% for executing malicious commands"** — Liu et al., https://arxiv.org/abs/2509.22040
7. **"A worktree is a fresh checkout, so untracked files like .env or .env.local from your main repository are not present."** — Anthropic docs, https://code.claude.com/docs/en/worktrees
8. **"now you have created the fun new ability to create merge conflicts with yourself"** — Scott Chacon, https://blog.gitbutler.com/parallel-claude-code
9. **"with worktrees I am not really able to easily copy secrets, etc to run my app, ports conflict"** — HN commenter Atotalnoob, https://news.ycombinator.com/item?id=47866750
10. **"Vitest and Vite both choked on the symlinked paths."** — Dave Schumaker, https://daveschumaker.net/use-git-worktrees-they-said-itll-be-fun-they-said/
11. **"Each managed Devin is a full Devin, running in its own isolated virtual machine"** — Cognition, https://cognition.com/blog/devin-can-now-manage-devins
12. **"isolated forks of both the code and the database, we can give AI agents a sandbox to try out changes in a safe environment"** — Replit, https://replit.com/blog/inside-replits-snapshot-engine
13. **"I think using the right sandboxes to safely run untrusted code is one of the most important problems to solve in 2026."** — Simon Willison, https://simonwillison.net/2026/Jan/6/a-field-guide-to-sandboxes-for-ai/

---

## 3. Where the evidence is weak or missing — bluntly

**Reproducibility is our weakest argument.** The only real support is benchmark infrastructure (SWE-bench + Epoch AI). That is eval tooling, not a developer's daily loop. **No verified source claims sandboxes make feature development more reproducible.** If we lead with reproducibility we are extrapolating from a benchmark harness to a product claim, and a technical reader will catch it.

**Parallelism is entirely vendor self-description.** Cursor, Google, Cognition and Replit all say isolation enables parallelism — in their own marketing-adjacent docs, about their own paid products. **There is no independent measurement that N sandboxed agents ship more merged code than N worktree agents.** Worse, the most credible independent practitioner cuts the other way: Willison's named bottleneck is "how fast I can review the results," not machine contention. If review is the constraint, buying more parallelism buys nothing.

**No verified source names git worktrees as a *security* failure mode.** Every worktree complaint on record is ergonomic — secrets, ports, DBs, `node_modules`, self-conflicts. The security literature argues *local/unisolated vs. isolated*; worktrees are merely one flavor of local. Do not present the 84% ASR number as a fact about worktrees. It was measured against Copilot and Cursor editors.

**No incident evidence.** Nobody in this set documents an actual agent destroying a real developer's machine or exfiltrating real secrets from a worktree setup. The risk is well-argued and demonstrated in labs; it is not yet evidenced in the wild in anything we can cite.

**No cost data at all.** Not one verified source compares the dollar or wall-clock cost of a sandbox against a free, instant local worktree. This will be the first question from any skeptical engineer and we currently have nothing.

**Sample size on the state-collision pain is ~5 HN commenters plus one blog post.** It is vivid and unsolicited, which is why it's persuasive, but it is anecdote, not survey.

### What we would have to demonstrate ourselves

1. **Time-to-first-useful-work**: sandbox cold start vs. worktree bootstrap on a real monorepo. Schumaker's ~10-minute `yarn install` is the number to beat; if we can't beat it, the whole state-isolation argument inverts.
2. **Collision rate at N agents** on one repo — ports, DB migrations, lockfiles, and ArielTM's semantic case — measured, not asserted.
3. **Throughput at N = 1 / 4 / 12** measured in *merged* PRs, to meet Willison's review-bottleneck objection head-on.
4. **A reproducibility receipt**: same commit + same image digest → same test result, twice, on two machines.
5. **An egress demo**: plant a canary secret, run a known injection payload, show the POST blocked. This is the only way to make "environment layer, not model layer" tangible.
6. **Unit cost per agent-hour**, published.

*Pattern worth noting in the rejected sources: both failed on metadata (a byline attributed to the company instead of the named author; a title reconstructed from a URL slug), not on substance — the quotes themselves verified verbatim. Chacon's account of one of a group of parallel agents breaking a fundamental part of the testing harness is the closest thing to a first-hand parallel-agent disaster story in this whole corpus, and it is currently unusable on a title error alone. Worth a re-verify pass.*

---

## 4. The honest counter-case

**Anthropic concedes the cost of sandboxing in print.** From the auto-mode post (John Hughes, 2026-03-25): *"Sandboxing is safe but high-maintenance: each new capability needs configuring, and anything requiring network or host access breaks isolation."* That is our single most damaging quote and it comes from the strongest possible source.

**Anthropic's current best-practices doc no longer recommends `--dangerously-skip-permissions` at all.** It recommends sandboxing *and* permission allowlists, with auto mode plus `--allowedTools` scoping for unattended fan-out. Auto mode itself is built on model-based classifiers, **not an isolation boundary**. So the "you need a sandbox to run YOLO safely" argument has weakened since 2025: the vendor's own recommended path for skipping approvals now routes around isolation.

**A container does not close the lethal trifecta.** Anthropic's devcontainer doc says it outright: dev containers do not prevent a malicious project from exfiltrating anything accessible inside the container, including the Claude Code credentials. So a sandbox alone isn't the answer — it's a sandbox *plus* default-deny egress, which is precisely the "high-maintenance" part.

**Willison's preferred sandbox is someone else's computer** — and he frames the worst case as leaked source code on that computer. For a founder with proprietary code, moving the work off the laptop trades a host-compromise risk for a source-disclosure risk. That is a real trade, not a free win.

**Isolation costs the agent capability.** OpenAI's Codex docs describe a two-phase runtime: network during setup, then the agent phase offline by default, with secrets removed before the agent phase starts. Safe — and also an agent that can't install a package, call an API, or read a doc mid-task.

**The state-collision complaints are being solved in place, without containers.** jamie_ca duplicates dev and test Postgres per worktree via lifecycle hooks and drops them on close; Conductor scripts `.env` copying into new worktrees; Anthropic shipped `.worktreeinclude`; Schumaker's recycled-slot pool only reinstalls when `yarn.lock` actually differs. Each of these erodes a bullet in §1(b).

**The problem may not be filesystem-shaped at all.** ArielTM's case — Agent A renames a type to X, Agent B independently renames the same type to Y — is not fixed by isolation, and arguably is made *worse* by it, since neither agent can see the other. As he puts it, filesystem parallelism is the easy half. And Chacon's answer is to abandon worktrees in the *other* direction: one working directory, multiple simultaneous sessions auto-sorted into virtual branches. The choice is not binary.

**The skeptic's best paragraph, stated fairly:** *A worktree is free, instant, and already on the machine I own. The real risks you're describing — injection, exfiltration, destructive commands — are risks of running agents unattended with permissions off, and Anthropic's own current guidance is to use auto mode and allowlists rather than to bypass permissions at all. Your sandbox doesn't stop credential exfiltration either, by Anthropic's own admission, unless I also build and maintain an egress firewall, which Anthropic separately calls high-maintenance and capability-limiting. My actual pain is secrets, ports and `node_modules`, and there are hooks and a `.worktreeinclude` for that. Meanwhile the most-cited practitioner in this space says his bottleneck is review speed, not machines. So: show me the setup cost, show me the throughput number, and show me the blocked exfiltration — or I'll keep my worktrees.*

**Our answer has to be #3 and #5 from §3.** Everything else in the brief is table stakes.

---

## Verified source list

| Source | Author | Date | URL |
|---|---|---|---|
| Making Claude Code more secure and autonomous with sandboxing | David Dworken and Oliver Weller-Davies (Anthr | October 20, 2025 | https://www.anthropic.com/engineering/claude-code-sandboxing |
| Choose a sandbox environment | Anthropic (Claude Code documentation) |  | https://code.claude.com/docs/en/sandbox-environments |
| Development containers | Anthropic (Claude Code documentation) |  | https://code.claude.com/docs/en/devcontainer |
| How we contain Claude across products | Max McGuinness, Mikaela Grace, Jiri De Jonghe | May 25, 2026 | https://www.anthropic.com/engineering/how-we-contain-claude |
| Security | Anthropic (Claude Code documentation) |  | https://code.claude.com/docs/en/security |
| Best practices for Claude Code | Anthropic (Claude Code documentation) |  | https://code.claude.com/docs/en/best-practices |
| How we built Claude Code auto mode: a safer way to skip permissions | John Hughes (Anthropic) | March 25, 2026 | https://www.anthropic.com/engineering/claude-code-auto-mode |
| How we built our multi-agent research system | Jeremy Hadfield, Barry Zhang, Kenneth Lien, F | June 13, 2025 | https://www.anthropic.com/engineering/multi-agent-research-system |
| Agent approvals & security \| ChatGPT Learn | OpenAI |  | https://developers.openai.com/codex/agent-approvals-security |
| Cloud Agents \| Cursor Docs | Cursor (Anysphere) |  | https://cursor.com/docs/cloud-agent |
| Build with Jules, your asynchronous coding agent | Kathy Korevec, Director, Product Management,  | 2025-05-20 | https://blog.google/innovation-and-ai/models-and-research/google-labs/jules/ |
| Devin can now Manage Devins | The Cognition Team | 2026-03-19 | https://cognition.com/blog/devin-can-now-manage-devins |
| Inside Replit's Snapshot Engine: The Tech Making AI Agents Safe | Connor Brewster and Luis Héctor Chávez (CTO), | 2025-12-17 | https://replit.com/blog/inside-replits-snapshot-engine |
| Devin 2.0 | Cognition | 2025-04-03 | https://cognition.com/blog/devin-2 |
| How we contain Claude across products | Anthropic (Max McGuinness, Mikaela Grace, Jir | 2026-05-25 | https://www.anthropic.com/engineering/how-we-contain-claude |
| Prompt injection to RCE in AI agents | Will Vandevanter, Trail of Bits | 2025-10-22 | https://blog.trailofbits.com/2025/10/22/prompt-injection-to-rce-in-ai-agents/ |
| "Your AI, My Shell": Demystifying Prompt Injection Attacks on Agentic AI Coding  | Yue Liu, Yanjie Zhao, Yunbo Lyu, Ting Zhang,  | 2025-09-26 (rev. 2026-04-28) | https://arxiv.org/abs/2509.22040 |
| AgentDojo: A Dynamic Environment to Evaluate Prompt Injection Attacks and Defens | Edoardo Debenedetti, Jie Zhang, Mislav Baluno | 2024-06-19 (NeurIPS 2024 D&B) | https://arxiv.org/abs/2406.13352 |
| Defeating Prompt Injections by Design | Edoardo Debenedetti, Ilia Shumailov, Nicholas | 2025-03-24 (rev. 2025-06-24) | https://arxiv.org/abs/2503.18813 |
| SWE-bench: Can Language Models Resolve Real-World GitHub Issues? | Carlos E. Jimenez, John Yang, Alexander Wetti | 2023-10-10 (rev. 2024-11-11) | https://arxiv.org/abs/2310.06770 |
| How to run SWE-bench Verified in one hour on one machine | Tom Adamczewski, Epoch AI | 2025-07-10 | https://epoch.ai/latest/swebench-docker |
| The lethal trifecta for AI agents: private data, untrusted content, and external | Simon Willison | 2025-06-16 | https://simonwillison.net/2025/Jun/16/the-lethal-trifecta/ |
| Living dangerously with Claude | Simon Willison | 2025-10-22 | https://simonwillison.net/2025/Oct/22/living-dangerously-with-claude/ |
| Designing agentic loops | Simon Willison | 2025-09-30 | https://simonwillison.net/2025/Sep/30/designing-agentic-loops/ |
| Embracing the parallel coding agent lifestyle | Simon Willison | 2025-10-05 | https://simonwillison.net/2025/Oct/5/parallel-coding-agents/ |
| Running OpenClaw in Docker | Simon Willison | 2026-02-01 | https://til.simonwillison.net/llms/openclaw-docker |
| A field guide to sandboxes for AI | Simon Willison (link post to a guide by Luis  | 2026-01-06 | https://simonwillison.net/2026/Jan/6/a-field-guide-to-sandboxes-for-ai/ |
| Run parallel sessions with worktrees — Claude Code Docs | Anthropic |  | https://code.claude.com/docs/en/worktrees |
| "Use git worktrees," they said. "It'll be fun!" they said. | Dave Schumaker | 2026-03-13 | https://daveschumaker.net/use-git-worktrees-they-said-itll-be-fun-they-said/ |
| Managing Multiple Claude Code Sessions Without Worktrees | Scott Chacon (GitHub co-founder, author of Pr | 2025-07-22 | https://blog.gitbutler.com/parallel-claude-code |
| Parallel agents in Zed (Hacker News discussion, 279 points) | Hacker News commenters (Atotalnoob, shmoogy,  | 2026-04-22 | https://news.ycombinator.com/item?id=47866750 |
| Embracing the parallel coding agent lifestyle | Simon Willison | 2025-10-05 | https://simonwillison.net/2025/Oct/5/parallel-coding-agents/ |

---

## Rescued sources (previously rejected on metadata only)

Both failed the first verification pass on **attribution**, not substance — their quotes verified verbatim.

### Katia Bazzi (Cursor) — *Run cloud agents in your own infrastructure*, 2026-03-25
https://cursor.com/blog/self-hosted-cloud-agents
*(Corrected: byline is Katia Bazzi; Cursor is publisher, not author.)*

Verified verbatim:
- "Isolated remote environments: each agent gets its own dedicated machine with no sharing, allowing for better parallelization."
- "Each agent session gets its own dedicated worker, which is initiated with a single command: agent worker start."
- "Workers can be long-lived or single-use, handling sessions indefinitely or tearing down as soon as a task is complete."
- "Many enterprises in highly-regulated spaces cannot let code, secrets, or build artifacts leave their environment due to security and compliance requirements."
- "Cursor now supports self-hosted cloud agents that keep your code and tool execution entirely in your own network."

Isolation granularity is **one machine per agent session** — the architectural analogue of one sandbox per task rather than N worktrees in one filesystem. Named customers: Brex, Money Forward, Notion.

**Read this source honestly — it cuts both ways:**
- The isolation claim is a single unelaborated marketing bullet. It never explains *why* isolation helps beyond "allowing for better parallelization" — no discussion of state collisions, dependency conflicts, or reproducibility. Citing it proves Cursor *ships* this design, not that the design is better.
- No comparative numbers at all. The one figure ("nearly 1,000 engineers", Money Forward testimonial) counts headcount, not concurrent agents.
- "Long-lived or single-use" concedes a worker may be reused indefinitely — ephemerality is a deployment option, not a principle.
- **The piece's thesis is nearly the opposite of "hosted sandboxes are fine."** Its premise is that vendor-hosted isolated environments were unacceptable to Brex/Notion/Money-Forward-class buyers, so Cursor moved execution onto customer hardware. That validates the "someone else's computer" objection as commercially decisive.
- Self-hosting costs a Helm chart, a Kubernetes operator and pool sizing — a large operational delta against `git worktree add`.

### Scott Chacon — *Grit: rewriting Git in Rust with agents*, Butler's Log, 2026-06-09
https://blog.gitbutler.com/true-grit
*(Corrected title: the earlier "True Grit" was reconstructed from the URL slug.)*

Verified verbatim (truncated — the source domain is blocked from fetching on this network, so the sentence could not be completed):
> "The reason this project took more than a few weeks is that I nearly gave up halfway through because one of a group of parallel agents broke a fundamental part of the testing harness and it…"

Context, **from search-result summaries and NOT independently verified** — treat as leads to confirm before publishing:
- Grit: a from-scratch Rust reimplementation of Git passing 99.3% of Git's own suite (41,715 / 42,001), ~360,000 lines, 500+ PRs, 7,000+ commits, in roughly 2–3 weeks, built with Claude Code, Cursor and Codex.
- Reported lessons include: **parallel long-running agents breaking shared state**; agents "cheating" by shelling out to Git; and directed bottom-up task decomposition beating unconstrained swarming.

This is the only first-hand account in the corpus of parallel agents causing real damage, from an unusually credible source on anything git-shaped. **Confirm the full sentence and the lessons list from the original before quoting them.**

---

## Positioning note: "your infrastructure"

Tempting framing, but Tenki sandboxes run in **Tenki's cloud**, not the customer's. E2B ships BYOC into your own AWS VPC; Cursor ships self-hosted workers. Claiming "your infrastructure" invites a comparison we currently lose.

The defensible claim is **unbundling the execution layer from the model vendor**. With Codex cloud or Claude Code on the web, the company that makes the model also runs your code and holds your repo. Tenki separates them: the sandbox is yours, the model is swappable (Aisa / Nebius / OpenRouter / opencode free tier via the broker relay), and real keys never enter the VM — each seat carries only a scoped, call-capped, revocable per-session token.

Candidate lines:
> "Your environment. Your choice of model. Neither one locked to the other."
> "Run agents without handing your codebase to the company that makes the model."

Bazzi's post is the evidence that *whose infrastructure* is commercially decisive — and also the evidence that our answer to it must be honest, since Cursor's answer is one we cannot currently match. Their framing is the useful one: **isolation and self-hosting are orthogonal axes.** BYOC is the roadmap item that would let us claim both.
