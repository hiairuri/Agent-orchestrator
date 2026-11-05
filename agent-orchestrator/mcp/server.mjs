#!/usr/bin/env node
/**
 * agent-orchestrator MCP server ("orch").
 *
 * Transport: stdio, newline-delimited JSON-RPC 2.0 (one request/response per line).
 * Dependencies: none — Node.js >= 18 builtins only (fs / path / crypto / readline /
 * child_process). child_process (v0.4) is used EXCLUSIVELY for local subprocesses:
 * the git CLI (sandbox worktrees; every git operation is a local object-database
 * operation and NO remote argv (push/pull/fetch/clone/remote/submodule) may ever
 * appear in this file), since v0.6 A6 a short-lived `node --input-type=module
 * -e` child that opens a SQLite file read-only via the node:sqlite builtin for
 * probe db.query (kept out-of-process so a bad DB cannot take the server down),
 * and since v1.1.1 W20 a detached local launcher (hooks/dispatch-runner.mjs) for
 * the headless dispatch primitive (no shell, args array straight to CreateProcess).
 * Network: this process performs no network I/O of any kind; storage is local files.
 *
 * Session tool full names are prefixed with: mcp__plugin_agent-orchestrator_orch__
 *   board | report | mailbox | spawn_agent | context_pack | resume | lessons |
 *   sandbox_apply | sandbox_discard | agent_harvest | probe | dispatch
 *   (v1.1.1 W20: 12 tools total; dispatch is appended last so the legacy ten stay
 *    a prefix and probe keeps its 11th position)
 *
 * Storage layout (under the resolved root, default <project>/.zcode/orchestrator):
 *   board.json
 *   root.txt                     (pointer to a custom root, written for hook scripts;
 *                                 v0.4.1: NOT written for temp-dir test roots, and a
 *                                 dangling pointer is removed + falls back to default)
 *   spool/<mission_id>/unread/<15-digit-zero-padded-epochMs>-<8hex>.json
 *   spool/<mission_id>/read/     (same names; consumed via rename)
 *   spool/<mission_id>/answers/<seq>-answer.json
 *   packs/<mission_id>/pack.md | pack-v1.md .. pack-vN.md
 *   sandboxes/<mission_id>/      (v0.4 git worktree sandboxes; removed by
 *                                 sandbox_apply / sandbox_discard only)
 *   archive/board-<ts>.json      (closed missions moved here by mailbox gc)
 *   memory/lessons.jsonl         (v0.3 learning memory: one lesson per line)
 *   context/journal-<sessionId>.jsonl  (v0.3 context mirror, written by hooks)
 *   sentinel.cfg.json            (v0.3 wake-sentinel config bridge, read-only here;
 *                                 v0.4.1: full v2 key set + signals block)
 *   sentinel/                    (v0.4.1 sentinel v2 family: instance-<k>.json slots,
 *                                 fired/ shot claims, echo.jsonl, coord-session.txt —
 *                                 owned by bg-sentinel.mjs; the server is READ-ONLY here
 *                                 except coord-session.txt which it refreshes)
 *   .lock/owner.json             (v0.3.1 root lock: {holder,pid,heartbeatAt}; all
 *                                 board read-modify-write sections run under it)
 *
 * v0.3.1 hotfix (red-team findings):
 *   A1 mkdir-type root lock around every board/answers/lessons read-modify-write.
 *   A2 loadBoard re-reads a "missing" board 3x before accepting empty; save uses a
 *      rename-only retry loop (unlink only after >=3 failures, then rename + verify).
 *   A3 answers written with flag:"wx"; on conflict the sequence number increments.
 *   A4 lessons.jsonl merge writes run under the same root lock.
 *   B7 negative elapsed (clock jumps) clamps to 0.
 *   B9 mailbox(read) treats rename ENOENT as "already consumed".
 *   C1 report(blocked/question) resets blocked.answered/answer and clears stale ack.
 *   C3 answer: only blocked/question may flip status to dispatched; terminal states
 *      answer back isError.
 *   C4 gc archives stale unread events too; resume unread_total excludes closed.
 *   C5 report to a closed mission stores the event but leaves the board untouched.
 *   C6 closing with unread events / a pending question adds a warn to the response.
 *
 * v0.4.0 (sandbox dispatch / dependency graph / parallel-iteration playbook):
 *   - context_pack gains isolation/oob_allowlist/share_node_modules; isolation=
 *     "worktree" materializes a git worktree sandbox under <root>/sandboxes/<id>
 *     (branch orch/<mission_id>, pack path rewriting, SANDBOX section, optional
 *     node_modules junction) — git subprocesses run inside the root lock.
 *   - New tools sandbox_apply / sandbox_discard: gated merge-back (done + qa.
 *     verdict=pass + clean main repo + allowlist + merge-tree precheck) and
 *     zero-damage discard. Subagents see neither (MCP_DISALLOWED).
 *   - Dependency graph: mission.blockedBy/owner/claim/skippedReason, statuses
 *     "ready"/"skipped", fixpoint sweepGraph on every board write (unlock,
 *     cascade skip, lease回收, dangling cleanup), board action=claim (in-lock
 *     CAS + lease), report renews the lease and hints ready_to_claim.
 *
 * v0.4.1 (sentinel v2 / harvest / robustness):
 *   - writeSentinelCfg publishes the full v2 key set + signals block; new argv
 *     --sentinel-family / --sentinel-grace-min (0.3.1 keys stay as bridges).
 *   - sentinelHealth(root): read-only view of <root>/sentinel/ attached to board
 *     list responses (instances / shots_24h / abandoned / echo_tail); resume
 *     gains a family-refill + abandoned-takeover action.
 *   - coord-session.txt refreshed from the resume tool's session_id channel;
 *     v0.10 G4 also writes the workspace anchor coord-workspace.txt (same
 *     root-derived key; read by the watcher as openBridge workspaceKeyHint).
 *     v0.10 G5 adds a startup filler: when coord-workspace.txt is absent the
 *     server publishes it (never overwrites; resume/SessionStart refresh).
 *   - agent_harvest: read-only subagent transcript harvester over the rollout
 *     model-io JSONL (last complete record's request.messages tail).
 *   - mergeMission whitelist: unknown top-level keys are dropped (reported in
 *     the upsert response as ignored_keys) instead of stored verbatim.
 *   - root.txt redesign: temp-dir test roots never write the global pointer; a
 *     dangling pointer is self-healed (removed) and readers fall back to default.
 *   - QA fixes: sandbox_apply idempotent branch moved ahead of the done/qa
 *     gates; report warn responses use distinct keys; dangling-dep timeline
 *     wording names the dropped ids.
 */
import readline from "node:readline";
import {
  ToolError, log, SERVER_NAME, SERVER_VERSION, PROTOCOL_VERSION_FALLBACK,
  projectDir, root,
} from "./server-core.mjs";
import { TOOL_HANDLERS, TOOLS } from "./server-registry.mjs";
import { orchMemoryAttachment } from "./server-memory.mjs";

/* ------------------------------------------------------------------ */
/* JSON-RPC plumbing                                                   */
/* ------------------------------------------------------------------ */

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + "\n");
}

function handleToolsCall(id, params) {
  const name = params && typeof params === "object" ? params.name : undefined;
  const args =
    params && typeof params === "object" && params.arguments && typeof params.arguments === "object"
      ? params.arguments
      : {};
  const handler = typeof name === "string" ? TOOL_HANDLERS[name] : undefined;
  if (!handler) {
    send({
      jsonrpc: "2.0",
      id,
      result: {
        content: [{ type: "text", text: JSON.stringify({ error: `unknown tool: ${String(name)}` }) }],
        isError: true,
      },
    });
    return;
  }
  try {
    const result = handler(args);
    // v0.8 (§4.2/§6.1): memory piggyback on every SUCCESSFUL tools/call —
    // orch_md ver-sync and the glean due signal ride the result as the
    // top-level optional `orch_memory` key (absent when nothing to say:
    // CR-04; error results below never attach; tools/list never gets here).
    const orchMemory = orchMemoryAttachment();
    // v1.3 W2 (design §3.2): third surfacing — content plane. When the
    // attachment carries orch_md with reason initial/changed/removed, mirror
    // the SAME att object into the result JSON top-level `orch_md` key
    // (single central injection before stringify covers every tool; P9
    // duplicate_warning precedent — result-content keys do reach the
    // coordinator). Spread builds a fresh object, no in-place mutation (L-6);
    // the att is reused from the one orchMemoryAttachment() construction,
    // never re-read from the file (L-7). unchanged → no key (zero-byte diff,
    // K3); the glean sub-object never enters content injection (due
    // boundary, OV-9). removed ships as the single-line {reason:"removed"}.
    const orchMdAtt =
      orchMemory && orchMemory.orch_md
        ? ["initial", "changed", "removed"].includes(orchMemory.orch_md.reason)
          ? orchMemory.orch_md
          : null
        : null;
    const contentResult = orchMdAtt ? { ...result, orch_md: orchMdAtt } : result;
    send({
      jsonrpc: "2.0",
      id,
      result: {
        content: [{ type: "text", text: JSON.stringify(contentResult) }],
        ...(orchMemory ? { orch_memory: orchMemory } : {}),
      },
    });
  } catch (err) {
    const message = err instanceof ToolError ? err.message : `${err && err.message ? err.message : err}`;
    if (!(err instanceof ToolError)) {
      log("tools/call internal error:", (err && err.stack) || String(err));
    }
    send({
      jsonrpc: "2.0",
      id,
      result: {
        content: [{ type: "text", text: JSON.stringify({ error: message }) }],
        isError: true,
      },
    });
  }
}

function dispatch(msg) {
  if (!msg || typeof msg !== "object" || Array.isArray(msg) || typeof msg.method !== "string") {
    // The line parsed as JSON but is not a request object: treat like a bad line.
    send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
    return;
  }
  const { id, method, params } = msg;
  if (typeof method === "string" && method.startsWith("notifications/")) {
    return; // notifications never get a reply
  }
  if (method === "initialize") {
    const requested =
      params && typeof params === "object" ? params.protocolVersion : undefined;
    const protocolVersion =
      typeof requested === "string" && requested.trim() ? requested : PROTOCOL_VERSION_FALLBACK;
    send({
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      },
    });
    return;
  }
  if (method === "ping") {
    send({ jsonrpc: "2.0", id, result: {} });
    return;
  }
  if (method === "tools/list") {
    send({ jsonrpc: "2.0", id, result: { tools: TOOLS } });
    return;
  }
  if (method === "tools/call") {
    handleToolsCall(id, params);
    return;
  }
  send({
    jsonrpc: "2.0",
    id: id === undefined ? null : id,
    error: { code: -32601, message: "Method not found" },
  });
}

const rl = readline.createInterface({ input: process.stdin, terminal: false });
rl.on("line", (line) => {
  const text = line.trim();
  if (!text) return;
  let msg;
  try {
    msg = JSON.parse(text);
  } catch {
    send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
    return;
  }
  try {
    dispatch(msg);
  } catch (err) {
    log("dispatch error:", (err && err.stack) || String(err));
    const id = msg && typeof msg === "object" && msg.id !== undefined ? msg.id : null;
    send({ jsonrpc: "2.0", id, error: { code: -32603, message: "Internal error" } });
  }
});
rl.on("close", () => process.exit(0));
rl.on("error", () => process.exit(0));
process.on("uncaughtException", (err) => {
  // All tool errors are already funneled into isError results; anything here is
  // logged without killing the stdio loop (state is reloaded from disk per call).
  log("uncaughtException:", (err && err.stack) || String(err));
});

log(`stdio JSON-RPC ready; project=${projectDir}; root=${root}`);

