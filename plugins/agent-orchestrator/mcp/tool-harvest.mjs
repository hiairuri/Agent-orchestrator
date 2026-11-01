// agent-orchestrator orch server — tool: agent_harvest（rollout 转录只读收割；机械拆分自 server.mjs L8594-8896）
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { ToolError, safeSegment, assertInside, displayPath } from "./server-core.mjs";
import { strictTokens } from "./server-boot.mjs";
import { loadBoard, findMission } from "./server-board.mjs";
/* ------------------------------------------------------------------ */
/* tool: agent_harvest (v0.4.1)                                        */
/*                                                                     */
/* Read-only subagent transcript harvester over the platform rollout    */
/* model-io JSONL (<homedir>/.zcode/cli/rollout/model-io-<sessionId>.   */
/* jsonl). Every record embeds the full conversation-so-far under       */
/* request.messages, so the LAST complete record is the freshest view.  */
/* Works across sessions (unlike TaskOutput) and needs no task id —     */
/* the coordinator resolves a finished subagent by mission/agent id.    */
/* Read-only: opens the rollout file, never writes anywhere.            */
/* ------------------------------------------------------------------ */

const HARVEST_DEFAULT_TAIL = 12;
const HARVEST_MAX_TAIL = 100;
const HARVEST_DEFAULT_CHARS = 8000;
const HARVEST_MAX_CHARS = 48000;
const HARVEST_LINE_CAP = 64 * 1024 * 1024; // refuse absurd records
const HARVEST_SCAN_CHUNK = 1024 * 1024;
// v0.6 (V6-50): bounded tail window for the malformed-last-line backoff — the
// fallback never walks further back than this, so a poisoned file cannot turn
// a harvest into a whole-file scan.
const HARVEST_TAIL_WINDOW = 256 * 1024;

function harvestRolloutDir() {
  const envDir = String(process.env.ORCH_ROLLOUT_DIR || "").trim();
  if (envDir) return path.resolve(envDir); // test seam only; default below
  return path.join(os.homedir(), ".zcode", "cli", "rollout");
}

/**
 * Last COMPLETE JSONL record (file ends with a newline → need the final two).
 *
 * v0.6 (V6-50): the happy path is unchanged (precise last-complete-line scan).
 * A malformed last line used to hard-fail the whole harvest forever. Now:
 *  - last line fails JSON.parse → walk the complete lines of a bounded 256KB
 *    tail window from the end; the first line that parses to an object is
 *    returned with lastLineUnparsable=true (caller adds last_line_unparsable).
 *  - last line parses but is NOT an object (bare scalar, V5-P4) → rec=null +
 *    lastLineScalar=true (caller: empty transcript + note, never a throw).
 *  - nothing parses within the window → rec=null + lastLineUnparsable=true
 *    (caller throws with an explicit "no fallback available" message).
 * A last line above capBytes still throws (explicit cap semantics, no fallback).
 */
function readLastJsonLine(file, capBytes) {
  const st = fs.statSync(file);
  const size = st.size;
  if (size === 0) return { rec: null, lastLineUnparsable: false, lastLineScalar: false };
  const fd = fs.openSync(file, "r");
  const readRange = (start, end) => {
    const b = Buffer.alloc(end - start);
    fs.readSync(fd, b, 0, end - start, start);
    return b.toString("utf8");
  };
  try {
    const nls = [];
    let pos = size;
    while (pos > 0 && nls.length < 2) {
      const n = Math.min(HARVEST_SCAN_CHUNK, pos);
      const buf = Buffer.alloc(n);
      fs.readSync(fd, buf, 0, n, pos - n);
      for (let i = n - 1; i >= 0; i--) {
        if (buf[i] === 10) {
          nls.push(pos - n + i);
          if (nls.length >= 2) break;
        }
      }
      pos -= n;
    }
    let start;
    let end;
    if (nls.length >= 2) {
      start = nls[1] + 1;
      end = nls[0];
    } else if (nls.length === 1) {
      start = 0;
      end = nls[0];
    } else {
      start = 0;
      end = size; // single unterminated line
    }
    const len = end - start;
    if (len > 0) {
      if (len > capBytes) {
        throw new ToolError(`转录末行 ${len} 字节超出收割上限（${capBytes}）`);
      }
      const text = readRange(start, end);
      try {
        const parsed = JSON.parse(text);
        if (parsed && typeof parsed === "object") {
          return { rec: parsed, lastLineUnparsable: false, lastLineScalar: false };
        }
        // V5-P4: a bare scalar record — empty transcript + note (no throw).
        return { rec: null, lastLineUnparsable: false, lastLineScalar: true };
      } catch {
        /* malformed last line → V6-50 tail-window backoff below */
      }
    }
    // V6-50 backoff: complete lines of the tail window, last first.
    const windowStart = Math.max(0, size - HARVEST_TAIL_WINDOW);
    const parts = readRange(windowStart, size).split("\n");
    // when the window starts mid-file the first element is cut mid-line — not
    // a complete line, never a backoff candidate
    const complete = windowStart > 0 ? parts.slice(1) : parts;
    while (complete.length && complete[complete.length - 1] === "") complete.pop();
    for (let i = complete.length - 1; i >= 0; i--) {
      const line = complete[i];
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line);
        if (parsed && typeof parsed === "object") {
          return { rec: parsed, lastLineUnparsable: true, lastLineScalar: false };
        }
      } catch {
        /* keep walking backwards */
      }
    }
    return { rec: null, lastLineUnparsable: true, lastLineScalar: false };
  } finally {
    fs.closeSync(fd);
  }
}

/** Flatten content (string | [{type:"text",text}|…]) to plain text. */
function harvestText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((p) => (p && typeof p === "object" && typeof p.text === "string" ? p.text : ""))
      .filter(Boolean)
      .join("\n");
  }
  return content == null ? "" : String(content);
}

function renderHarvestMessages(messages, includeTools, tail) {
  // H1 (v0.5, D2 §1.2): tail=0 → probe mode, zero transcript echo.
  // (slice(-0) === slice(0) would return the WHOLE array — guard it.)
  const slice = tail > 0 ? messages.slice(-tail) : [];
  const lines = [];
  for (const m of slice) {
    if (!m || typeof m !== "object") continue;
    const role = String(m.role || "?");
    if (role === "system") {
      lines.push("[system] " + harvestText(m.content).replace(/\s+/g, " ").slice(0, 160));
    } else if (role === "user") {
      lines.push("[user] " + harvestText(m.content).replace(/\s+/g, " ").slice(0, 400));
    } else if (role === "assistant") {
      const text = harvestText(m.content).replace(/\s+/g, " ").trim();
      lines.push("[assistant] " + (text ? text.slice(0, 600) : "(无文本)"));
      if (includeTools && Array.isArray(m.toolCalls)) {
        for (const tc of m.toolCalls) {
          if (!tc) continue;
          let inputHead = "";
          try {
            inputHead = JSON.stringify(tc.input ?? {}).slice(0, 160);
          } catch {
            inputHead = "";
          }
          lines.push(`    → ${String(tc.name || "?")}(${inputHead})`);
        }
      }
    } else if (role === "tool") {
      const err = m.isError ? " ERROR" : "";
      lines.push(
        `[tool ${String(m.toolName || "?")}${err}] ` +
          harvestText(m.content).replace(/\s+/g, " ").slice(0, 240),
      );
    } else {
      lines.push(`[${role}] ` + harvestText(m.content).replace(/\s+/g, " ").slice(0, 240));
    }
  }
  return { lines, count: slice.length, truncated: messages.length > slice.length };
}

function toolAgentHarvest(args) {
  let tail = Math.floor(Number(args.tail));
  // H1 (v0.5): 0 is now legal — probe mode (metadata only, zero echo); <0/non-numeric still default.
  if (!Number.isFinite(tail) || tail < 0) tail = HARVEST_DEFAULT_TAIL;
  tail = Math.min(HARVEST_MAX_TAIL, tail);
  let maxChars = Math.floor(Number(args.max_chars));
  if (!Number.isFinite(maxChars) || maxChars < 200) maxChars = HARVEST_DEFAULT_CHARS;
  maxChars = Math.min(HARVEST_MAX_CHARS, maxChars);
  const includeTools = args.include_tools !== false;

  // v0.6 (V6-19A, AUTH-07): strict mode narrows harvest addressing to
  // mission_id only — session_id/agent_id raw-transcript reads must go through
  // the board (which records the dispatch), stacking with V6-16's guards.
  if (
    strictTokens &&
    (String(args.session_id ?? "").trim() || String(args.agent_id ?? "").trim())
  ) {
    throw new ToolError(
      "agent_harvest：--strict-tokens 模式仅接受 mission_id 定位" +
        "（session_id/agent_id 直读已收口为经板面解析 dispatch.agent_id），请改传 mission_id",
    );
  }

  // v0.6 (V6-16): session_id/agent_id are path segments of the rollout file —
  // pass both through safeSegment, then re-verify the composed path stays
  // inside the rollout dir (double guard, same pattern as packDir).
  let sessionId = String(args.session_id ?? "").trim();
  if (sessionId) {
    sessionId = safeSegment(sessionId, "session_id");
  } else {
    const agentId = String(args.agent_id ?? "").trim();
    if (agentId) {
      const base = agentId.startsWith("sess_") ? agentId : `sess_subagent_agent_${safeSegment(agentId, "agent_id")}`;
      sessionId = safeSegment(base, "session_id");
    }
  }
  let missionId = null;
  if (!sessionId && args.mission_id != null) {
    missionId = safeSegment(args.mission_id, "mission_id");
    const m = findMission(loadBoard(), missionId);
    if (!m) throw new ToolError(`mission not found: ${missionId}`);
    const aid = (m.dispatch && m.dispatch.agent_id) || null;
    if (!aid) throw new ToolError(`mission ${missionId} 无 dispatch.agent_id（未派发或池工领取，无转录可收割）`);
    sessionId = safeSegment(`sess_subagent_agent_${safeSegment(aid, "agent_id")}`, "session_id");
  }
  if (!sessionId) {
    throw new ToolError('agent_harvest 需要 session_id / agent_id / mission_id 其一');
  }

  const file = path.join(harvestRolloutDir(), `model-io-${sessionId}.jsonl`);
  assertInside(harvestRolloutDir(), file);
  if (!fs.existsSync(file)) {
    throw new ToolError(
      `未找到转录 model-io-${sessionId}.jsonl（rollout 目录 ${harvestRolloutDir()}）。` +
        "未派发、池工领取、或平台未写 rollout 时无转录可收割；终态产出请以 report artifacts 为准",
    );
  }
  let rec;
  let fileBytes;
  // v0.6 (V6-50): last-line degradation flags — surfaced as conditional
  // response keys (last_line_unparsable / note) instead of a hard failure.
  let lastLineUnparsable = false;
  let lastLineScalar = false;
  try {
    const lr = readLastJsonLine(file, HARVEST_LINE_CAP);
    rec = lr.rec;
    lastLineUnparsable = lr.lastLineUnparsable;
    lastLineScalar = lr.lastLineScalar;
    fileBytes = fs.statSync(file).size; // H1 (v0.5): one statSync for the file_bytes metadata
  } catch (err) {
    if (err instanceof ToolError) throw err;
    throw new ToolError("转录读取失败：" + (err && err.message ? err.message : err));
  }
  if (!rec && lastLineScalar) {
    // V5-P4 / V6-50: bare scalar last record — keep the ok response, degrade to
    // an empty transcript, and say so (was: silent empty result).
    rec = { request: { messages: [] } };
  }
  if (!rec) {
    throw new ToolError(
      lastLineUnparsable
        ? "转录无可解析记录（末行畸形且尾窗回退 256KB 内无完整可解析行，无回退可用）"
        : "转录文件为空或无完整记录",
    );
  }
  const messages = Array.isArray(rec.request && rec.request.messages) ? rec.request.messages : [];
  // H1 (v0.5, D2 §1.2): exact last-record usage + file facts, already in hand from the parse.
  // input_tokens is the LAST record's response.usage.inputTokens verbatim (W2 21/21 precise anchor);
  // no byte-ratio estimation anywhere. Fallback 2KB tail-read probe stays unactivated (D2 §1.2 备选).
  const usage =
    rec.response && rec.response.usage && typeof rec.response.usage === "object" ? rec.response.usage : null;
  const messagesKind = (rec.request && rec.request.messagesKind) ?? null;
  const rendered = renderHarvestMessages(messages, includeTools, tail);
  let transcript = rendered.lines.join("\n");
  const fullLen = transcript.length;
  if (transcript.length > maxChars) transcript = "…（头部截断，保留尾部）\n" + transcript.slice(transcript.length - maxChars);

  return {
    ok: true,
    session_id: sessionId,
    mission_id: missionId,
    source: displayPath(file),
    completed_at: rec.completedAt ?? null,
    model_id: (rec.model && rec.model.modelId) || (rec.response && rec.response.modelId) || null,
    message_count: messages.length,
    rendered_messages: rendered.count,
    tail_truncated: rendered.truncated,
    transcript_chars: fullLen,
    transcript,
    // v0.6 (V6-50): last-line degradation is visible, never silent —
    // last_line_unparsable when the tail window backoff returned an earlier
    // record; note when the last line was a bare scalar (empty transcript).
    ...(lastLineUnparsable
      ? { last_line_unparsable: true, note: "转录末行畸形不可解析，已回退至上一条完整记录" }
      : {}),
    ...(lastLineScalar ? { note: "转录末行为合法 JSON 标量（非对象），已按空转录处理" } : {}),
    // H1 (v0.5, D2 §1.2): additive probe metadata — tail=0 turns this response into the
    // zero-echo probe mode (transcript empty) for CR-10 usage sampling. Keys only, no new tool.
    usage: usage
      ? {
          input_tokens: usage.inputTokens ?? null,
          output_tokens: usage.outputTokens ?? null,
          cache_read_tokens: usage.cacheReadTokens ?? null,
        }
      : null,
    file_bytes: fileBytes,
    messages_kind: messagesKind,
  };
}

export {
  toolAgentHarvest,
  harvestRolloutDir,
};
