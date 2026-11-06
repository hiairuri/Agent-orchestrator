// agent-orchestrator orch server — trajectory：context/coord-tail-log.md 写面（v1.6 W-t 新建，design §2.2）
// 第 13 号工具（主控专属，单 action append；追加注册尾位=probe 11/dispatch 12 先例，旧工具位次零漂移）。
// 承接 hooks/stop-check.mjs R7 写段退役（grill#3 OPEN-1 终裁「废除原写面，用 MCP 写面」）：
// 协议行 server 铸（ts=调用时点 / seq=文件内最大 seq+1 跨会话单调）、ORT v3 块格式落盘（读面零迁）、
// 20/10 滞回原子重写裁回、帽校验 isError 化（旧静默拒写+stderr 改善为调用即知）、
// flying 缺席自动以 board running/dispatched 清单补全、回执 {ok, seq, blocks, trimmed}。
import fs from "node:fs";
import path from "node:path";
import { root, nowIso, escapeDataLine, atomicWriteFileSync, ToolError } from "./server-core.mjs";

const TRAJ_LOG_FILE = "coord-tail-log.md"; // v1.6 N3 值 twin 供值：W3a 与 tool-pack TRAJ_LOG_FILE 成对（单侧漂移红）
const TRAJ_TRIM_AT = 20; // v1.6 W-t 滞回上限（迁移自 stop-check COORD_TAIL_LOG_TRIM_AT；数字零手术，20 块不滑动最上不丢）
const TRAJ_TRIM_TO = 10; // v1.6 W-t 裁剪目标（迁移自 COORD_TAIL_LOG_TRIM_TO；触发时原子重写保留的最新块数，含新块）
// ORT v3 主标记对（v1.4 C2-a 形制；历史 v2 全形块照常计数/解析——存量保留不回写，C2-05 容忍半面承袭）。
const TRAJ_MARK = "<!-- orch-tail v3";
const TRAJ_MARK_V2 = "<!-- orch-tail v2";
const TRAJ_CLOSE = "<!-- orch-tail-end -->";
const TRAJ_CAPS = {
  full: { lines: 10, bytes: 900 },
  short: { lines: 6, bytes: 400 },
};
const TRAJ_FLYING_MAX = 3;

const trajLogFile = () => path.join(root, "context", TRAJ_LOG_FILE);

/** 单行字段值整备：折叠空白（换行会破坏 ORT 块行结构）+ 控制字符转义（escapeDataLine 同源）。 */
function trajFieldValue(value) {
  return escapeDataLine(String(value ?? "").replace(/\s+/g, " ")).trim();
}

/** flying 值 → 条目数组（「无」/空 = 零条目；全形整表与短形 delta 共用）。 */
function trajFlyingItems(value) {
  const s = String(value ?? "").trim();
  if (!s || s === "无" || s === "（无）" || s === "-") return [];
  return s
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
}

/** 日志块扫描（v3 主标记 + v2 legacy 双标识别，旧→新；坏尾块忽略）。 */
function trajScanBlocks(raw) {
  const lines = String(raw ?? "").split(/\r?\n/);
  const blocks = [];
  let open = -1;
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (t === TRAJ_MARK || t === TRAJ_MARK_V2) open = i;
    else if (t === TRAJ_CLOSE && open >= 0) {
      blocks.push({ lines: lines.slice(open, i + 1) });
      open = -1;
    }
  }
  return blocks;
}

/** 块内单字段取值（首个 `field: value` 行；无则 null）。 */
function trajBlockField(block, field) {
  const re = new RegExp(`^${field}: (.+)$`);
  for (const line of block.lines.slice(1, -1)) {
    const m = re.exec(line.trim());
    if (m) return m[1].trim();
  }
  return null;
}

/** seq 协议行数值（非整数行返回 null）。 */
function trajBlockSeq(block) {
  const raw = trajBlockField(block, "seq");
  if (raw == null || !/^\d+$/.test(raw)) return null;
  const seq = Number(raw);
  return Number.isSafeInteger(seq) ? seq : null;
}

/** 全形判定（承袭 PL-10①：携 project/stage/ruled 任一业务字段=全形）。 */
function trajIsFull(block) {
  return ["project", "stage", "ruled"].some((f) => trajBlockField(block, f) != null);
}

/** 文件内最大 seq（跨会话单调基数；坏 seq 行跳过，缺文件/无块 = 0）。 */
function trajMaxSeq(raw) {
  let max = 0;
  for (const b of trajScanBlocks(raw)) {
    const seq = trajBlockSeq(b);
    if (seq != null && seq > max) max = seq;
  }
  return max;
}

/** flying 缺席自动补全（design §2.2 增强项）：board running/dispatched 清单，
 *  最近更新优先（updated_at 降序、id 升序兜底），取 ≤3 条；空板 = 「无」。
 *  在飞 >3 时主控如需全景须显式传 flying（schema 描述同口径）。 */
function trajFlyingAutoFill() {
  let missions = [];
  try {
    const board = JSON.parse(fs.readFileSync(path.join(root, "board.json"), "utf8"));
    if (board && typeof board === "object" && Array.isArray(board.missions)) missions = board.missions;
  } catch {
    /* 无板/不可读 = 空清单 */
  }
  const flying = missions
    .filter((m) => m && typeof m === "object" && (m.status === "running" || m.status === "dispatched") && m.id)
    .sort((a, b) => {
      const ta = Date.parse(String(a.updated_at || "")) || 0;
      const tb = Date.parse(String(b.updated_at || "")) || 0;
      return tb - ta || String(a.id).localeCompare(String(b.id));
    })
    .slice(0, TRAJ_FLYING_MAX)
    .map((m) => String(m.id));
  return flying.length ? flying.join(", ") : "无";
}

/** ORT v3 块渲染（标记对/字段行格式不变——读面零迁；协议行 ts/seq 由本写面 server 铸）。 */
function trajRender(state) {
  return [
    TRAJ_MARK,
    `ts: ${state.ts}`,
    `seq: ${state.seq}`,
    `project: ${state.project}`,
    `stage: ${state.stage}`,
    `flying: ${state.flying}`,
    `ruled: ${state.ruled}`,
    `next: ${state.next}`,
    TRAJ_CLOSE,
  ].join("\n");
}

/** 帽校验（TRAJ_CAPS 结构迁移自 COORD_TAIL_CAPS）：超帽=ToolError 当场拒（isError 化）。 */
function trajCapError(blockText, form) {
  const cap = TRAJ_CAPS[form];
  const lines = blockText.split("\n").length;
  const bytes = Buffer.byteLength(blockText, "utf8");
  if (lines > cap.lines) return new ToolError(`block over cap (${lines} lines > ${cap.lines} lines); this call is rejected`);
  if (bytes > cap.bytes) return new ToolError(`block over cap (${bytes}B > ${cap.bytes}B); this call is rejected`);
  return null;
}

/**
 * trajectory 工具（第 13 号，主控专属）：单 action append——把主控申报态追加进
 * `<存储根>/context/coord-tail-log.md`（ORT v3 块；写触发=主控纪律 PL-10① 收工轮调用）。
 * full=变化轮（project/stage/ruled/next 恒主控申报；flying 缺席自动补全）；
 * short=稳态轮（仅 next 必带；project/stage/ruled 自文件内最新全形块继承〔server 侧合并，
 * 跨会话继承取代旧「同会话链」界面〕；flying=+id/-id 增删）；append 无判旧，陈旧块由滞回帽老化。
 */
export function toolTrajectory(args) {
  const kind = args && args.kind;
  if (kind !== "full" && kind !== "short") {
    throw new ToolError(`trajectory requires kind: "full" | "short"; got ${JSON.stringify(kind ?? null)}`);
  }
  const field = (name) => {
    const v = args[name] == null ? null : trajFieldValue(args[name]);
    return v === "" ? null : v;
  };
  const project = field("project");
  const stage = field("stage");
  const ruled = field("ruled");
  const next = field("next");
  if (kind === "full" && (!project || !stage || !ruled || !next)) {
    throw new ToolError("trajectory full requires non-empty project/stage/ruled/next");
  }
  if (kind === "short" && !next) {
    throw new ToolError("trajectory short requires non-empty next");
  }

  const file = trajLogFile();
  let raw = "";
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    raw = ""; // 缺日志 ≈ 空基线
  }
  const blocks = trajScanBlocks(raw);

  // flying 整备：全形缺席=board 自动补全；短形=+id/-id 增删（自最新全形基线合并）。
  let flying;
  if (kind === "full") {
    if (args.flying == null) {
      flying = trajFlyingAutoFill();
    } else {
      const items = trajFlyingItems(args.flying);
      if (items.some((x) => /^[+-]/.test(x))) {
        throw new ToolError("full-form flying must be the whole list (+/- prefixes banned)");
      }
      if (items.length > TRAJ_FLYING_MAX) {
        throw new ToolError(`flying exceeds ${TRAJ_FLYING_MAX} items`);
      }
      flying = items.join(", ") || "无";
    }
  } else {
    const baselineBlock = (() => {
      for (let i = blocks.length - 1; i >= 0; i--) {
        if (trajIsFull(blocks[i])) return blocks[i];
      }
      return null;
    })();
    if (!baselineBlock) {
      throw new ToolError("missing the full-form baseline (no full block in the file); a short form never creates the file - write a full form first");
    }
    const items = trajFlyingItems(trajBlockField(baselineBlock, "flying"));
    if (args.flying != null) {
      for (const token of trajFlyingItems(args.flying)) {
        if (!/^[+-]\S+$/.test(token)) {
          throw new ToolError(`short-form flying must be +id/-id: ${token}`);
        }
        const id = token.slice(1);
        const at = items.indexOf(id);
        if (token[0] === "-") {
          if (at >= 0) items.splice(at, 1); // - 不存在的 id 忽略不报错
        } else if (at < 0) {
          items.push(id);
        }
      }
    }
    if (items.length > TRAJ_FLYING_MAX) {
      throw new ToolError(`flying exceeds ${TRAJ_FLYING_MAX} items after the merge`);
    }
    flying = items.join(", ") || "无";
  }

  // 协议行 server 铸：ts=调用时点；seq=文件内最大 seq+1（跨会话单调，声明变更自「会话内单调」强化）。
  const state = {
    ts: nowIso(),
    seq: trajMaxSeq(raw) + 1,
    project: kind === "full" ? project : "",
    stage: kind === "full" ? stage : "",
    flying,
    ruled: kind === "full" ? ruled : "",
    next,
  };
  if (kind === "short") {
    // 短形 project/stage/ruled 自文件内最新全形块继承（缺省字段=不变非清空）。
    for (let i = blocks.length - 1; i >= 0; i--) {
      if (!trajIsFull(blocks[i])) continue;
      state.project = trajBlockField(blocks[i], "project") ?? state.project;
      state.stage = trajBlockField(blocks[i], "stage") ?? state.stage;
      state.ruled = trajBlockField(blocks[i], "ruled") ?? state.ruled;
      break;
    }
  }

  // 帽校验（TRAJ_CAPS 结构迁移自 COORD_TAIL_CAPS，isError 化）：full=落盘 ORT 块 10 行/900B；
  // short=短形 delta 视图 6 行/400B（ts/seq/flying/next 形）∧ 落盘合并块（全形形制）仍守全形帽
  // ——旧写面短形入日志即合并全形（coordTailMerge 语义承袭），落盘恒为全形形状。
  const mergedText = trajRender(state);
  if (kind === "full") {
    const capErr = trajCapError(mergedText, "full");
    if (capErr) throw capErr;
  } else {
    const shortView = [
      TRAJ_MARK,
      `ts: ${state.ts}`,
      `seq: ${state.seq}`,
      `flying: ${args.flying == null ? "无" : trajFieldValue(args.flying) || "无"}`,
      `next: ${next}`,
      TRAJ_CLOSE,
    ].join("\n");
    const shortErr = trajCapError(shortView, "short");
    if (shortErr) throw shortErr;
    const mergedErr = trajCapError(mergedText, "full");
    if (mergedErr) throw mergedErr;
  }

  // 滞回 20/10（迁移自 coordTailAppendLog）：累积至 20 不滑动（最上不丢）；第 21 块触发
  // 原子重写裁回最新 10（含新块）——tmp+rename 原子写（atomicWriteFileSync 同源）。
  let trimmed = false;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (blocks.length + 1 > TRAJ_TRIM_AT) {
    const keep = blocks
      .slice(blocks.length - (TRAJ_TRIM_TO - 1))
      .map((b) => b.lines.join("\n"));
    atomicWriteFileSync(file, [...keep, mergedText].join("\n\n") + "\n", root);
    trimmed = true;
  } else {
    const sep = !raw.trim() ? "" : raw.endsWith("\n") ? "\n" : "\n\n";
    fs.appendFileSync(file, sep + mergedText + "\n");
  }
  return { ok: true, seq: state.seq, blocks: trimmed ? TRAJ_TRIM_TO : blocks.length + 1, trimmed };
}
