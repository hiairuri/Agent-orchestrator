#!/usr/bin/env node
/**
 * agent-orchestrator SessionStart hook.
 *
 * stdin : JSON payload (hook_event_name, session_id, ...). ZCODE_PROJECT_DIR is in env.
 * stdout: nothing when there is nothing to resume; otherwise strict JSON
 *         {"additionalContext": "..."} (single line, <= 1500 chars).
 * exit  : always 0 (silence on any error; never blocks session start).
 *
 * v0.2: terminal missions (done/failed/blocked/question) whose result was never
 * claimed by the coordinator ("疑似唤醒失败") also re-enter the resume briefing,
 * flagged and with the result age appended; acked-deferred ones stay silent.
 *
 * v0.3: the briefing ends with a one-line lessons digest (global score top-3,
 * <= 300 chars; the whole line is dropped when over budget).
 *
 * v0.10 G5 (anchor trust root trigger): every SessionStart republishes the
 * paired wake anchors <root>/sentinel/coord-session.txt (this session id) and
 * coord-workspace.txt (the project root resolved from the storage root) atomically,
 * before the board check.
 * Rationale: resume-only dual-write left coord-workspace.txt missing after an
 * app restart (EXP10 R4), which made the watcher fall back to workspaces[0]
 * and let b2 self-heal hijack the session anchor. stdout/exit contract
 * unchanged (still silent when there is nothing to resume).
 *
 * v0.10 G14 (subagent anchor filter): on app restart the host replays
 * SessionStart for subagent sessions too (sess_subagent_agent_<agentId>;
 * live evidence EXP10-findings R6, 2026-10-25 03:14), so the unconditional
 * G5 republish hijacked the wake target to a worker session. publishWakeAnchor
 * now skips subagent-prefixed ids entirely (no anchor files touched);
 * coordinator ids (sess_<uuid>, no subagent segment) are unaffected.
 *
 * v1.1.1 W-A0 (managed-worker anchor skip): headless workers spawned by
 * dispatch-runner carry ORCH_MANAGED_WORKER=<mission_id> in their environment;
 * their SessionStart skips publishWakeAnchor entirely. Live evidence
 * 2026-10-25: a `-p` probe session (sess_<uuid> shape, not covered by G14)
 * hijacked coord-session.txt via the unconditional republish — with W20
 * headless dispatch at volume the anchor would end up pointing at the last
 * started worker.
 *
 * Storage root discovery: <project>/.zcode/orchestrator/root.txt (pointer to a
 * custom root) if present, otherwise the default directory itself.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const MAX_OUTPUT_CHARS = 1500;
// v0.3.1 (C2): "resumed" joins the open set — a resumed mission whose worker
// died used to be missing from the resume briefing.
const OPEN_STATUSES = ["dispatched", "running", "blocked", "question", "resumed"];
const RESULT_STATUSES = ["done", "failed", "blocked", "question"];
const BRIEF_TOP_K = 3;
const BRIEF_MAX_CHARS = 300;
// v1.2 M9-1 触发面①（复活/自补员）：心跳新鲜刻度与 bg-sentinel/bg-gate 同值 90000
// （VALUE_TWINS 异名值 twin 语义名=心跳龄判死；本副本独立命名防 twin 表 site 计数漂移）。
const REVIVE_HB_STALE_MS = 90000;
const SENTINEL_SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), "bg-sentinel.mjs");

/* --- lessons digest（v0.8 起唯一副本：server.mjs 同名死码 topLessonsBrief 已删，
     v0.8-DESIGN §3.6；v0.6 V6-57 起本副本多做代理对回退） --- */

function truncateStr(value, max) {
  const s = String(value ?? "");
  if (s.length <= max) return s;
  // v0.6 (V6-57): 切点落在高位代理（emoji 等前半）则回退一位，避免产出孤立代理。
  const cut =
    max > 0 && s.charCodeAt(max - 1) >= 0xd800 && s.charCodeAt(max - 1) <= 0xdbff
      ? max - 1
      : max;
  return s.slice(0, cut);
}

function loadLessons(rootDir) {
  let raw;
  try {
    raw = fs.readFileSync(path.join(rootDir, "memory", "lessons.jsonl"), "utf8");
  } catch {
    return [];
  }
  const list = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const obj = JSON.parse(line);
      if (obj && typeof obj === "object" && !Array.isArray(obj)) list.push(obj);
    } catch {
      /* skip bad line */
    }
  }
  return list;
}

function lessonScore(l, now = Date.now()) {
  let conf = Number(l && l.confidence);
  if (!Number.isFinite(conf)) conf = 0;
  conf = Math.min(1, Math.max(0, conf));
  let hits = Number(l && l.hits);
  if (!Number.isFinite(hits) || hits < 1) hits = 1;
  const ts = Date.parse(String((l && l.updated_at) || ""));
  const days = Number.isFinite(ts) ? Math.max(0, (now - ts) / 86400000) : 0;
  return conf * (1 + Math.log(hits)) * Math.exp(-days / 30);
}

/** Global score top-3 active lessons as one line; "" when empty or over budget. */
function topLessonsBrief(rootDir) {
  const now = Date.now();
  const list = loadLessons(rootDir)
    .filter((l) => l && l.status === "active")
    .map((l) => ({ l, score: lessonScore(l, now) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, BRIEF_TOP_K);
  if (!list.length) return "";
  const body = list
    .map(({ l }) => `[${l.type}] ${truncateStr(String(l.trigger ?? ""), 40)}→${truncateStr(String(l.fix ?? ""), 60)}`)
    .join("；");
  const line = `相关教训：${body}。`;
  return line.length <= BRIEF_MAX_CHARS ? line : "";
}

/* --- ack / suspected wake-failure helpers (verbatim twin of server.mjs) --- */

function missionAck(m) {
  return m && m.ack && typeof m.ack === "object" ? m.ack : null;
}

function lastResultAt(m) {
  const timeline = m && Array.isArray(m.timeline) ? m.timeline : [];
  for (let i = timeline.length - 1; i >= 0; i--) {
    const entry = timeline[i];
    if (
      entry &&
      typeof entry === "object" &&
      typeof entry.event === "string" &&
      entry.event.startsWith("report:")
    ) {
      if (entry.at != null) return String(entry.at);
    }
  }
  if (m && m.updated_at != null) return String(m.updated_at);
  return null;
}

function wakeFailureInfo(m) {
  const suspected = Boolean(
    m &&
      typeof m === "object" &&
      RESULT_STATUSES.includes(m.status) &&
      Boolean(m.dispatch && m.dispatch.agent_id) &&
      missionAck(m) === null &&
      (m.dispatch && m.dispatch.mode) !== "workflow",
  );
  if (!suspected) return { suspected: false, result_at: null, minutes: null };
  const resultAt = lastResultAt(m);
  const ms = resultAt == null ? NaN : Date.parse(resultAt);
  // B7: clock jumps must not produce negative ages.
  const minutes = Number.isFinite(ms) ? Math.max(0, Math.floor((Date.now() - ms) / 60000)) : null;
  return { suspected: true, result_at: resultAt == null ? null : resultAt, minutes };
}

function fmtAge(min) {
  if (min == null || !Number.isFinite(min)) return "";
  if (min < 1) return "刚刚";
  if (min < 60) return `${min} 分钟前`;
  return `${Math.floor(min / 60)} 小时 ${min % 60} 分钟前`;
}

/* -------------------------------------------------------------------------- */

function readStdinJson() {
  try {
    const raw = fs.readFileSync(0, "utf8");
    if (!raw.trim()) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/* --- root-id 契约校验定根（v0.6；verbatim twin：五脚本同文，行为由 tests/suites/root-contract.mjs
     矩阵锁定，零代码共享）---
   分代门：temp 拒绝（两代通用）→ v2 强校验（root-id 比对）/ v1 弱校验（存在即采信 + stderr 提示）
   → 任一失败回退默认根 + stderr 告警一行。hooks 不删指针（删除职责全归 server 自愈）。
   本函数为各脚本内定根唯一副本（stop-check 主清点与镜像记录两条路径共用）。
   v1.1.1 (W20/W22) 祖先回退：默认根既无 board.json 也无 root-id（无指针/空指针/校验失败回退）时，
   自 projectDir 向上逐级找最近祖先目录，其 .zcode/orchestrator 同时存在 board.json 与 root-id
   即采用（stderr 一行告知解析根）；找不到则静默默认根。root.txt 指针优先级不变。 */
function isTempLikeDir(p) {
  try {
    const tmp = path.resolve(os.tmpdir());
    const r = path.resolve(p);
    const rel = path.relative(tmp, r);
    return rel !== "" && !rel.startsWith(".." + path.sep) && !path.isAbsolute(rel);
  } catch {
    return false;
  }
}

function rootIdOf(rootPath) {
  try {
    return fs.readFileSync(path.join(rootPath, "root-id"), "utf8").trim();
  } catch {
    return ""; // 无 root-id（≤v0.4.0 旧版 server 根 / 非存储目录）
  }
}

function rootContractStderr(msg) {
  try {
    process.stderr.write("[agent-orchestrator] " + msg + "\n");
  } catch {
    /* stderr 不可写也不阻塞 */
  }
}

/** 祖先回退判定（v1.1.1 W20/W22；五处 twin 同文）：默认根自身合法（board.json 或 root-id 任一存在）
 *  → 默认根；否则自 projectDir 向上找最近祖先的 .zcode/orchestrator（须同时有 board.json 与
 *  root-id）。命中 → stderr 一行（含解析根路径）后采用；未命中 → 默认根（静默）。cwd 漂移防护。 */
function ancestorRoot(projectDir, defaultRoot) {
  try {
    if (
      fs.existsSync(path.join(defaultRoot, "board.json")) ||
      fs.existsSync(path.join(defaultRoot, "root-id"))
    ) {
      return defaultRoot; // 默认根合法（新项目即便还没板，只要有 root-id 也不回退）
    }
    let dir = path.dirname(path.resolve(projectDir));
    for (;;) {
      const candidate = path.join(dir, ".zcode", "orchestrator");
      if (
        fs.existsSync(path.join(candidate, "board.json")) &&
        fs.existsSync(path.join(candidate, "root-id"))
      ) {
        rootContractStderr("定根回退：采用祖先根 " + candidate);
        return candidate;
      }
      const parent = path.dirname(dir);
      if (parent === dir) return defaultRoot; // 已到文件系统根仍无命中
      dir = parent;
    }
  } catch {
    return defaultRoot; // 任何意外 → 默认根（fail-open，不阻塞）
  }
}

/** 存储根发现：root.txt 指针优先，采信前过分代门；无指针（或空指针）→ 默认根（先做祖先
 *  回退判定）；任一校验失败 → 回退默认根 + stderr 告警（同样做祖先回退判定）。不删指针。 */
function locateRoot(projectDir) {
  const defaultRoot = path.join(projectDir, ".zcode", "orchestrator");
  const fallbackRoot = () => ancestorRoot(projectDir, defaultRoot);
  try {
    const pointer = path.join(defaultRoot, "root.txt");
    if (!fs.existsSync(pointer)) return fallbackRoot();
    const lines = fs
      .readFileSync(pointer, "utf8")
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (!lines.length) return fallbackRoot(); // 空指针 ≈ 无指针
    const target = lines[0];
    if (isTempLikeDir(target)) {
      rootContractStderr("root.txt 指针未通过归属校验（目标位于临时目录），已回退默认根");
      return fallbackRoot();
    }
    let live = false;
    try {
      live = fs.statSync(target).isDirectory();
    } catch {
      live = false; // 悬空指针
    }
    if (!live) {
      rootContractStderr("root.txt 指针未通过归属校验（指针目标不存在或不是目录），已回退默认根");
      return fallbackRoot();
    }
    const rid = rootIdOf(target);
    if (lines.length >= 2) {
      // v2 强校验：目标存活 ∧ root-id 存在 ∧ 内容 === 指针内嵌 id
      if (!rid) {
        rootContractStderr("root.txt 指针未通过归属校验（目标根缺少 root-id），已回退默认根");
        return fallbackRoot();
      }
      if (rid !== lines[1]) {
        rootContractStderr("root.txt 指针未通过归属校验（root-id 与指针内嵌 id 失配），已回退默认根");
        return fallbackRoot();
      }
      return target;
    }
    // v1 弱校验（v0.4.1–v0.5.1 旧格式兼容）：目标存活 ∧ root-id 存在即采信（值不比对）
    if (!rid) {
      rootContractStderr("root.txt 指针未通过归属校验（旧格式指针且目标根无 root-id），已回退默认根");
      return fallbackRoot();
    }
    rootContractStderr("root.txt 为旧格式指针（v1 弱校验已采信），重启 server 后自动升级");
    return target;
  } catch {
    return fallbackRoot(); // 任何意外 → 默认根（fail-open，不阻塞）
  }
}

function loadBoard(rootDir) {
  const file = path.join(rootDir, "board.json");
  if (!fs.existsSync(file)) return null;
  try {
    const board = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!board || typeof board !== "object" || Array.isArray(board)) return null;
    if (!Array.isArray(board.missions)) return null;
    return board;
  } catch {
    return null;
  }
}

/* --- v0.10 G5 锚互信根触发（session-start 面） -------------------------------
 * EXP10-findings R4：应用 12:31 重启后 coord-session.txt 在、coord-workspace.txt 缺失
 * （G4 的双写只挂在 resume 调用上，而 SessionStart 从不写锚）→ watcher 无锚盲取
 * workspaces[0] → b2 在错工作区建会话 → 回读刷新劫持 coord-session。
 * 修法：SessionStart 以自身 session_id + 存储根对应项目根（resolveRoot 上两级；祖先回退
 * 命中后即真实项目根）无条件重发布**成对**锚
 * （session+workspace 同源同刻，保持互信根一致；新启动的会话即最新唤醒目标）。
 * 写面纪律：best-effort 永不 fatal、原子 tmp+rename、不改变 hook 事件契约（stdin/stdout
 * 形状与退出码不变）。session_id 按 journal.mjs 同款字符集消毒（防路径/换行注入）。
 */
function safeSessionId(value) {
  return String(value ?? "").replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 256);
}

function atomicWriteBestEffort(file, data) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp-${process.pid}-${Date.now().toString(36)}`;
    fs.writeFileSync(tmp, data);
    fs.renameSync(tmp, file);
  } catch {
    /* best effort：锚写失败不阻塞会话启动 */
  }
}

function publishWakeAnchor(rootDir, projectDir, sessionId) {
  // v1.1.1 W-A0 锚写面身份鉴别：headless 托管 worker 不抢主控锚。dispatch-runner spawn
  // CLI 时落 ORCH_MANAGED_WORKER=<mission_id>，-p worker 会话的 SessionStart 见之即跳过
  // 发布（零副作用，不触碰任何锚文件）。锚劫持活体实证 2026-10-25：-p 探针会话
  // （sess_7ac10f4b）经本函数无条件发布抢占 coord-session.txt——G14 只滤 sess_subagent_*
  // 前缀，-p 全会话 sess_<uuid> 形状拦不住，哨兵 3 实例曾正读死锚=兜底降级。手工 -p
  // 残留挂账（无 env，锚活性校验兜底）；常规 watcher b2 三重守卫保留。
  if (process.env.ORCH_MANAGED_WORKER) return;
  const sid = safeSessionId(sessionId);
  if (!sid) return;
  // v0.10 G14 锚重发布子代理过滤（活体实证 2026-10-25 03:14，EXP10-findings R6）：
  // app 重启恢复时宿主对子代理会话（sess_subagent_agent_<agentId>，形状锚=
  // bg-sentinel.mjs / server.mjs agent_harvest 同源）也触发 SessionStart，G5 的
  // 无条件重发布把成对锚改指子代理会话 → 唤醒目标劫持（用户实测唤醒未达主控）。
  // 子代理会话 id 在入口跳过：不写任何锚文件（零写/零触碰存量锚）。用前缀形而非
  // 全形匹配，覆盖未来 sess_subagent_* 变体；主控会话 id 形状 sess_<uuid> 无
  // subagent 段，不受影响。
  if (sid.startsWith("sess_subagent")) return;
  atomicWriteBestEffort(path.join(rootDir, "sentinel", "coord-session.txt"), sid + "\n");
  // v1.1.1 W24（W22 遗留③c）：工作区锚提升为「存储根对应的项目根」——存储根为约定形
  // <project>/.zcode/orchestrator 时取 resolveRoot 上两级（祖先回退命中后即真实项目根，cwd
  // 漂移到子目录时不再把子目录路径写进锚，避免 watcher 精确匹配 workspace-list 时
  // bridge-anchor-mismatch）；root.txt 指向自定义根（非约定形）时仍取 projectDir。
  const workspaceRoot =
    path.basename(rootDir) === "orchestrator" && path.basename(path.dirname(rootDir)) === ".zcode"
      ? path.resolve(rootDir, "..", "..")
      : path.resolve(projectDir);
  atomicWriteBestEffort(path.join(rootDir, "sentinel", "coord-workspace.txt"), workspaceRoot + "\n");
}

function countUnread(rootDir, missionId) {
  try {
    return fs
      .readdirSync(path.join(rootDir, "spool", missionId, "unread"))
      .filter((f) => f.endsWith(".json")).length;
  } catch {
    return 0;
  }
}

/* --- v1.2 M9-1 触发面①（复活/自补员·SessionStart 面） -----------------------
 * 根因（§6.2b）：哨兵为 hook 独立进程家族，宿主重启即团灭且无复活=后续 mission 无盯守
 * （「子代理半天未签收不开枪」实锤）。SessionStart 对宿主重启后非交互首会话同样触发
 * （实锚 T0：M0-2 findings §2/§5——-p 会话 shot B SessionStart hook input 实采，
 * source:"startup"；插件 hook 在 -p 会话照常执行），故首会话即复活时机。
 * 补员前置四闸（缺一不拉起）：
 *   ①W-A0 同闸：ORCH_MANAGED_WORKER 托管 worker 不补员（headless 家族由 dispatch
 *     触发面②负责，worker 会话短寿命不背补员职责）；
 *   ②G14 同闸：sess_subagent 前缀子代理会话不补员；
 *   ③板在场：无 board.json=无可盯守面（纯 hooks 面旧部署维持 bg-gate 提示补员老路径）；
 *   ④server 管理面在岗：sentinel.cfg.json 在场（server 启动恒写，v0.9 sparse）——无 cfg
 *     的根不自动补员（防纯夹具/异构根误拉起；派发触发面②与提示路径兜底）。
 * 家族全灭（任一 fresh 槽位在岗即让位）才拉起，数量=cfg family_size（缺省 3，1..5 钳制）；
 * 多余实例由槽位 wx 认领仲裁自然让位退出（幂等，重复触发无害）。best-effort 永不 fatal。 */
function sentinelFreshSlotExists(rootDir) {
  try {
    const sentDir = path.join(rootDir, "sentinel");
    for (const name of fs.readdirSync(sentDir)) {
      if (!/^instance-\d+\.json$/.test(name)) continue;
      const f = path.join(sentDir, name);
      try {
        const doc = JSON.parse(fs.readFileSync(f, "utf8"));
        const pid = Number(doc && doc.pid);
        if (!Number.isFinite(pid) || pid <= 0) continue;
        let alive = false;
        try {
          process.kill(pid, 0);
          alive = true;
        } catch (err) {
          alive = Boolean(err && err.code === "EPERM");
        }
        if (!alive) continue;
        const hb = Date.parse(String((doc && doc.heartbeatAt) ?? ""));
        let age = Number.isFinite(hb) ? Date.now() - hb : NaN;
        if (!Number.isFinite(age)) {
          try {
            age = Date.now() - fs.statSync(f).mtimeMs;
          } catch {
            continue;
          }
        }
        if (Math.max(0, age) <= REVIVE_HB_STALE_MS) return true;
      } catch {
        /* bad slot file → next */
      }
    }
  } catch {
    /* no sentinel dir → family dead */
  }
  return false;
}

function reviveSentinelFamily(rootDir, sessionId) {
  if (process.env.ORCH_MANAGED_WORKER) return; // W-A0 同闸
  const sid = safeSessionId(sessionId);
  if (!sid || sid.startsWith("sess_subagent")) return; // G14 同闸
  if (!fs.existsSync(path.join(rootDir, "board.json"))) return; // 无板无可盯守
  let familySize = 3;
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(rootDir, "sentinel.cfg.json"), "utf8"));
    familySize =
      cfg && Number.isFinite(cfg.family_size) ? Math.min(5, Math.max(1, Math.round(cfg.family_size))) : 3;
  } catch {
    return; // 无 cfg/坏 cfg → server 管理面不在岗，不自动补员（闸④）
  }
  if (sentinelFreshSlotExists(rootDir)) return; // 家族在岗（standby 亦在岗）→ 让位
  for (let k = 0; k < familySize; k++) {
    try {
      spawn(process.execPath, [SENTINEL_SCRIPT, "--root", rootDir], {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
      }).unref();
    } catch {
      /* best effort：补员失败不阻塞会话启动 */
    }
  }
}

function main() {
  const input = readStdinJson();
  const projectDir = process.env.ZCODE_PROJECT_DIR || process.cwd();
  const sessionId = typeof input.session_id === "string" ? input.session_id : "";
  const rootDir = locateRoot(projectDir);
  // v0.10 G5：互信根触发先于板面判定——即使无板/无可恢复任务也要发布唤醒目标对
  // （watcher 无锚 fail-loud；锚缺失=唤醒链断点，见 publishWakeAnchor 注）。
  publishWakeAnchor(rootDir, projectDir, sessionId);
  // v1.2 M9-1 触发面①：宿主重启后首会话复活哨兵家族（锚已先发布——复活实例天然有锚；
  // 四闸见 reviveSentinelFamily 注）。
  reviveSentinelFamily(rootDir, sessionId);
  const board = loadBoard(rootDir);
  if (!board) return;

  const isWakeFailure = (m) => wakeFailureInfo(m).suspected;
  const resumable = board.missions.filter((m) => {
    if (!m || typeof m !== "object") return false;
    if (m.status === "closed") return false;
    const open = OPEN_STATUSES.includes(m.status);
    // "Unanswered" only counts when a question was actually asked: fresh
    // missions default to blocked.answered === false without ever asking.
    const unanswered = Boolean(m.blocked && m.blocked.answered === false && m.blocked.question);
    // v0.2: terminal missions join only when their result looks unclaimed
    // (疑似唤醒失败); acked-deferred old dones do not disturb a new session.
    const unclaimedTerminal = RESULT_STATUSES.includes(m.status) && isWakeFailure(m);
    return open || unanswered || unclaimedTerminal;
  });
  if (!resumable.length) return;

  const lines = ["[agent-orchestrator] 检测到可恢复任务："];
  let totalUnread = 0;
  for (const m of resumable.slice(0, 8)) {
    const unread = countUnread(rootDir, m.id);
    totalUnread += unread;
    const seed = String(m.original_prompt || m.title || "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 60);
    let line =
      `- [${m.id}] ${m.title || "(未命名)"}｜${m.status}｜${m.agent_type || "-"}` +
      `｜原任务：${seed ? seed + "…" : "（未记录）"}${unread ? `｜未读 ${unread} 条` : ""}`;
    if (isWakeFailure(m)) {
      const w = wakeFailureInfo(m);
      const age = fmtAge(w.minutes);
      line =
        `- 【疑似唤醒失败】${line.slice(2)}` +
        (age ? `｜${m.status} 于 ${age}，未签收` : `｜${m.status} 未签收`);
    }
    lines.push(line);
  }
  if (totalUnread > 0) lines.push(`未读邮箱事件 ${totalUnread} 条。`);
  // v0.3: one-line lessons digest; dropped entirely when over its own budget or
  // when it would push the briefing past the output cap.
  const lessonsLine = topLessonsBrief(rootDir);
  if (lessonsLine) {
    const projected = text0Length(lines) + 1 + lessonsLine.length;
    if (projected <= MAX_OUTPUT_CHARS) lines.push(lessonsLine);
  }
  lines.push(
    `本会话 session_id=${sessionId || "(未知)"}（派发时请记入 board）；` +
      "接力计划：/orch-resume 或 mcp__plugin_agent-orchestrator_orch__resume；" +
      "终态未签收的结果先 mailbox(read) 接手再处置。",
  );

  let text = lines.join("\n");
  if (text.length > MAX_OUTPUT_CHARS) text = truncateStr(text, MAX_OUTPUT_CHARS - 3) + "...";
  process.stdout.write(JSON.stringify({ additionalContext: text }));
}

function text0Length(lines) {
  return lines.join("\n").length;
}

try {
  main();
} catch {
  /* silence on any error: hooks must never block a session */
}
process.exit(0);
