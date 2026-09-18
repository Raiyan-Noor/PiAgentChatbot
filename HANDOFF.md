# HANDOFF

Living coordination file between you (the human) and me (the implementing agent).
Updated at every milestone.

## 1. Status board

| Milestone | Status | Notes |
|---|---|---|
| M0 – Scaffold + spikes | ✅ done | S1–S4 all verified live against real Daytona + Convex cloud (see §6). |
| M1 – Contract + control plane | ✅ done | Deployed to `dev:necessary-shark-787`; unit tests + `npm run e2e:local`. |
| M2 – Execution plane | ✅ done | Snapshot `pi-runner-fe30c896a2c7` live; all 8 tools exercised by the real agent, no tool errors. |
| M3 – Lifecycle | ✅ done | Live: warm pool, idle stop, resume, recreate-after-VM-deletion, snapshot rollover, orphan sweep. |
| M4 – UI | ✅ done | Screenshot-verified (chat, tool cards, 5 inspector tabs). |
| M5 – Bench + docs | ✅ done | Real Daytona+OpenAI numbers in the README; demo script in §7. |

**Verification (all green, 2026-09-18):** `npm run typecheck` · `npm run lint` · `npm test` (14 Convex + 6 runner) · `npm run spike:pi` · `npm run e2e:local` · `npm run spike:daytona` · **`npm run e2e:daytona`** (live acceptance, 22/22 checks) · `npm run bench -- --n 5`

**Headline numbers** (p50, live): hot-path dispatch **61 ms** vs LLM TTFT **729 ms** · warm thread ready **516 ms** · cold **2995 ms** · resume-from-stopped to first token **3448 ms**.

**Nothing is committed yet.** Tell me if you want commits, and whether I may push to `origin`.

## 2. What I need from you

- [x] Daytona API key, OpenAI key, Tavily key — all working live.
- [x] Convex cloud deployment (`dev:necessary-shark-787`) — functions + env vars pushed, crons running.
- [x] Snapshot built and set: `pi-runner-fe30c896a2c7`.
- [ ] **Only open item: may I commit, and may I push to `origin`?** Nothing has been committed yet.
- [ ] Optional: raise the Daytona tier if you want more than ~10 concurrent sandboxes (see §4).

## 3. How to run it

Everything below is already done on this machine; this is the reproduce-from-scratch list.

1. `npm install` (also installs `runner/`).
2. `npx convex dev` — leave running (cloud dev deployment; sandboxes need a `*.convex.cloud` URL).
3. Fill `.env.local` from `.env.example`, then `npm run env:push`.
4. `npm run snapshot` — builds the runner image on Daytona and sets `DAYTONA_SNAPSHOT`.
5. `npm run dev:web` — the UI. A warm sandbox is already waiting, so a new thread is ready in ~0.5 s.

Checks: `npm run e2e:daytona` (live, ~90 s, cleans up after itself) · `npm run bench -- --n 5` · `npm test`.

## 4. Cost & safety notes

- `SANDBOX_POOL_SIZE` (default 1) keeps that many VMs **running idle** for instant threads. Set 0 to save credits.
- Idle thread VMs stop after `SANDBOX_IDLE_STOP_MINUTES` (default 10).
- Dead-man's switch: Daytona auto-stops after `DAYTONA_AUTOSTOP_MINUTES` (default 30) if the control plane stops refreshing.
- Every sandbox carries labels `app=pi-agent-chatbot` and `deployment=<convex deployment>`. Filter by them in the Daytona dashboard. The `daytona observe` cron deletes labelled VMs that have no live row.
- A circuit breaker stops recreating a thread's sandbox after 3 failures in 10 min (bad snapshot/key/quota).
- **Your Daytona tier caps total CPU at 10**, and each sandbox is 1 CPU — so ~10 concurrent sandboxes
  (pool + live threads). Hit live while benchmarking with n=5; `scripts/bench.ts` now releases each
  iteration's sandbox as soon as it has its sample. The control plane surfaces the limit as a normal
  sandbox `error` ("Total CPU limit exceeded"), the circuit breaker stops the retry loop, and the UI
  shows it in the Sandbox tab.

## 5. Decisions log & open questions

- 2026-09-17 — LLM provider: OpenAI. Web search: Tavily.
- 2026-09-17 — Default model `gpt-5.4-mini` (in pi-ai 0.85.1's registry, reasoning-capable, fast). Override with `DEFAULT_MODEL`.
- 2026-09-17 — Local Node is v22.17.0; Pi requires ≥ 22.19. Works in practice; the VM image uses `node:22-bookworm-slim`.
- 2026-09-17 — **No `convex.json` `externalPackages`**: the local Convex backend on Windows 500s on push with it. esbuild bundles `@daytona/sdk` into the Node action fine. If the cloud action misbehaves at runtime, re-add `{"node":{"externalPackages":["@daytona/sdk"]}}`.
- 2026-09-17 — `runner/` is a standalone npm package (own lockfile), not a workspace, so the image can `npm ci` it on its own.
- 2026-09-17 — Workspace path in the VM is `/workspace` (not `/home/daytona/...`): the custom image doesn't assume a `daytona` user.
- 2026-09-17 — Added optional `DAYTONA_OPENAI_SECRET`: a Daytona org Secret, so the real OpenAI key never enters the VM (Daytona swaps a placeholder on egress).
- 2026-09-17 — Pi compaction disabled: it would rewrite history in ways the Convex transcript can't mirror. Long threads will eventually hit the context window (documented tradeoff).
- 2026-09-18 — **Sandbox egress is SNI-allowlisted by tier** (TCP connects, then RST right after the TLS
  ClientHello). Measured from a real sandbox: **reachable** — `*.convex.cloud`, `*.convex.site`,
  `api.openai.com`, `registry.npmjs.org`, `pypi.org`, `github.com`, `raw.githubusercontent.com`;
  **blocked** — `example.com`, `api.tavily.com`, and the apex `convex.cloud`. This is exactly the
  assumption `convex/execution/egress.ts` is built on, so `webfetch`/`websearch` brokered through
  Convex is the right (and only) design here. It cannot be widened per sandbox: passing
  `domainAllowList` is rejected with *"Network access is restricted and cannot be overridden at the
  sandbox level"* (https://www.daytona.io/docs/en/network-limits/#tier-based-network-restrictions).
  Upgrading the Daytona tier is the only way to open it.
- 2026-09-18 — Demo script shot 2 (`fetch https://example.com`) is **unaffected**: `webfetch` is
  brokered by Convex, which has no allowlist. Only a *VM-direct* fetch (the agent's own `bash` +
  `curl`) is constrained — if a shot needs that, use an allowlisted host like
  `raw.githubusercontent.com` or `pypi.org`.
- 2026-09-18 — **Image ships its own `fd` v10.2.0** (from the GitHub release) instead of Debian
  bookworm's `fd-find` 8.6: Pi's `find` tool (behind our `glob`) always passes `--no-require-git`,
  which 8.6 rejects — `glob` failed on the first live run. The image build now also *verifies*
  `fd --no-require-git` and `rg --version` at build time, so a broken toolchain fails the snapshot
  build instead of a user's tool call. Snapshot `pi-runner-fe30c896a2c7`.
- 2026-09-18 — Convex/Daytona co-location is fine in practice: hot-path dispatch is 61 ms p50 with
  Convex dev (US) and Daytona target `us`.

## 6. Spike results

| Spike | Result |
|---|---|
| S1 Daytona SDK in a Convex Node action | ✅ **verified live**: the reconciler cron creates/starts/stops/deletes sandboxes from the bundled Node action on the cloud deployment (no `externalPackages` needed). |
| S2 WSS from a sandbox to `*.convex.cloud` + env visible to entrypoint | ✅ **verified live** (2026-09-18) against `https://necessary-shark-787.convex.cloud`: `verdict: "subscription ok"`, **first update 74 ms**, `isWebSocketConnected: true`, 0 retries. `CONVEX_URL`/`SANDBOX_TOKEN`/`WORKSPACE_DIR` all present in the daemon's own env (`/proc/1/environ`). |
| S3 Pi session: OpenAI model id, custom tools, events, rehydration | ✅ `npm run spike:pi` (faux LLM) **and live**: the real agent used all 8 tools in one turn on `gpt-5.4-mini` (10 LLM turns, 5486→351 tokens, $0.0065), no tool errors. |
| S4 entrypoint restarts after stop/start | ✅ **verified live** on `pi-runner-f9b395d1e58d` (2026-09-18): `daemon.mjs` running as of create; create 1.3 s, stop 1.3 s, start 0.7 s; daemon comes back on its own after restart, no exec call. Node `v22.23.2`, `ripgrep`/`git`/`python3` present (and `fd` v10.2.0 since `pi-runner-fe30c896a2c7`). |
| Local E2E (both planes, no Daytona) | ✅ `npm run e2e:local`: dispatch 34 ms, first text 115 ms after send, FIFO, cancel, daemon restart rehydrates. |
| **Live acceptance** (`npm run e2e:daytona`) | ✅ **22/22** on 2026-09-18: warm thread ready 1.4 s · all 8 tools, no errors · websearch via egress broker · webfetch reaches example.com through Convex (blocked from the VM) · stop mid-run → aborted in 1.07 s · stop/resume keeps memory **and** workspace files, same VM · VM deleted via the Daytona API → thread recreated on a new VM, conversation intact, `thread.workspace_reset` logged · no orphaned sandboxes after cleanup. |

## 7. Demo script (cap.so)

Before recording: `SANDBOX_POOL_SIZE=1`, `SANDBOX_IDLE_STOP_MINUTES=1` (for shot 4), Inspector open.

1. **Instant thread from the pool** (~20 s). Sidebar fleet shows `pooled 1`. Click **New thread**: the badge is `ready` immediately. Sandbox tab: "from pool", `pool_claim` transition. Note the new `provisioning` row topping the pool back up.
2. **Streaming + all 8 tools** (~60 s). Prompt: *"Create fib.py that prints the first 10 Fibonacci numbers, run it, edit it to print 20, grep for def, glob *.py, fetch https://example.com, and search the web for Daytona sandboxes."* Point at live tool output, the structured cards (exit code, diff, match counts, search results), and the Timeline waterfall (queue→claim ms vs LLM time, parallel tools).
3. **Cancel** (~15 s). Ask for something long, press **Stop**, and show the run go `aborted` in well under a second.
4. **Stop / resume with memory** (~40 s). Click **Stop VM** (or wait for idle stop): `stopping → stopped`. Send "what file did you create earlier?". The badge goes `starting → ready`, the agent answers from memory and `fib.py` is still there. Sandbox tab: start and boot spans.
5. **Delete the VM behind our back** (~40 s). Delete the sandbox in the Daytona dashboard, then send a message. A new sandbox is provisioned, a `thread.workspace_reset` event appears, the conversation is remembered, and the files are gone (explicitly).
6. **Architecture + numbers** (~40 s). README diagram: "no Daytona call per message". Show the `npm run bench` table: hot-path dispatch vs LLM TTFT, cold vs warm vs resume.
7. **Cleanup** (~10 s). Delete threads. The Daytona dashboard filtered by `app=pi-agent-chatbot` is empty.
