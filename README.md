# Agent Orchestrator

Coordinator-grade subagent orchestration plugin for ZCode — 让主控 agent 真正管控子代理。

## What it does

A ZCode plugin that turns "dispatch and hope" into accountable delegation:

- **Mission board** — `board.json` state machine (drafted → dispatched → running → done/failed/closed), coordinator ack, wake-failure detection, upstream `blockedBy` dependency graph with claim leases and cascade unlock.
- **File spool mailbox** — structured worker reporting (`milestone` / `blocked` / `question` / `done`) with token-authenticated contracts, plus P2P direct arbitration between workers.
- **Context packs** — verbatim context materialization for every dispatch: read-first lists, rules, upstream excerpts, budget tiers (S/M/L), optional git-worktree sandboxing with `merge-tree` pre-check gates and scope allowlists.
- **Direct-mode wake channel** — a watcher daemon that wakes the coordinator over a local loopback relay (watcher → relay shim 127.0.0.1:47010 → desktop → CLI injection), bypassing the cloud relay; every wake is judged by a three-proof verdict (transport ack, acceptance, rollout-revival probe) with fail-loud workspace anchoring.
- **Sentinel watchdog** — a standby-based background family that never fully exits: stall alarms for in-flight missions, wake-failure alarms for unacked results, family teardown/rotation.
- **Lessons library** — cross-mission learning memory: workers file candidates via reports, the coordinator promotes/merges them; score decay, counter-evidence (`contradicts`) chains, auto-retire.
- **Memory consolidation** — candidate lessons flow through staging into curated views (`ORCH.md` for coordinators, `AGENTS.md` marker sections for subagents, a global cross-project store) maintained by a gated, lock-protected consolidation agent that runs on demand.
- **Structured probe** — a server-enforced capped read tool (SQL/file/grep/binary inspect) with pagination and hash envelopes, so the coordinator can peek without context bloat.

**11 MCP tools**, 4 hook events, a 22-chapter SKILL manual, 20 test suites (1043 assertions) via `tests/run-all.mjs`.

## Install

Add this repository as a ZCode plugin marketplace source — the manifest lives at `plugins/marketplace.json`:

```
git@github.com:hiairuri/Agent-orchestrator.git
```

Then enable the `agent-orchestrator` plugin from the marketplace.

## Requirements

- ZCode (Windows tested; the MCP server is a zero-dependency single-file Node script)
- Git (only needed for sandboxed dispatch features)

## Repository layout

```
plugins/
  marketplace.json          # marketplace manifest
  agent-orchestrator/       # the plugin
    mcp/server.mjs          # zero-dependency MCP server (11 tools)
    hooks/                  # sentinel, bg-gate, session-start, stop-check
    skills/                 # 22-chapter operations manual
    watcher/                # direct-mode wake daemon + loopback relay shim (opt-in, local-only)
    commands/  agents/      # slash commands and subagent personas
    tests/                  # 20 suites, run-all / run-smoke harnesses
```

## Status

Pre-1.0; the tool surface and protocols still evolve between minor versions. Developed and tested on Windows.

## License

[Apache-2.0](LICENSE)
