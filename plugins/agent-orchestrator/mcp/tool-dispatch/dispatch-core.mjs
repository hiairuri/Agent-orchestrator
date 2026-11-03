// agent-orchestrator orch server — dispatch IO/主流程模块（provenance：v1.5 W2-A T7 裁 a 自 mcp/tool-dispatch.mjs
// 单文件〔1647 行，ece2e80 基〕机械拆分 :302-767+:1045-1643 逐字搬运：resolve/读取+哨兵/组合捕获+provider env+
// 播种配置+toolDispatchInner/toolDispatch 主流程下沉（R1-L3 口径）。本件 > 软帽 900=准入即豁免登记（LM-06-CAP
// OPEN-E 判则 b，G3-3 预填；拆分切面=组装纯区 vs IO 主流程，再下切=主流程手术另案评估）。
// 薄入口=mcp/tool-dispatch.mjs（注册导出接线）；组装纯区=./dispatch-prompt.mjs；模型/拥塞=./dispatch-model.mjs。

import fs from "node:fs";
import path from "node:path";
import child_process from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  root, projectDir, safeSegment, ToolError, displayPath, withRootLock,
  atomicWriteFileSync,
} from "../server-core.mjs";
import { strictTokens } from "../server-boot.mjs";
import { loadBoard, findMission, upsertMission } from "../server-board.mjs";
import { SENTINEL_HEARTBEAT_STALE_MS } from "../server-sentinel.mjs";
import { harvestRolloutDir } from "../tool-harvest.mjs";
import { readProjectDigest } from "../server-memory.mjs";
import {
  buildDispatchPrompt,
  dispatchRoleBare,
  DISPATCH_ROLE_PERSONAS,
  DISPATCH_READONLY_ROLES,
  DISPATCH_DEFAULT_TIMEOUT_MIN,
} from "./dispatch-prompt.mjs";
import {
  dispatchPickSeedModel,
  dispatchListApikeyProviders,
  dispatchCongestionOff,
  dispatchCongestionTtlMin,
  dispatchCongestionRead,
  dispatchCongestionStamped,
  dispatchCongestionStampPair,
} from "./dispatch-model.mjs";

function dispatchDigestRead() {
  try {
    return readProjectDigest();
  } catch {
    return null; // digest is an optional section; never block dispatch
  }
}

/** pack resolution: mission.pack.path → explicit pack_path → <root>/packs/<id>/pack.md */
function resolveDispatchPack(mission, explicit) {
  const candidates = [];
  if (mission.pack && mission.pack.path) candidates.push(String(mission.pack.path));
  if (explicit != null && String(explicit).trim() !== "") candidates.push(String(explicit).trim());
  candidates.push(path.join(root, "packs", mission.id, "pack.md"));
  for (const candidate of candidates) {
    const p = path.isAbsolute(candidate) ? candidate : path.resolve(projectDir, candidate);
    try {
      if (fs.statSync(p).isFile()) return p;
    } catch {
      /* next candidate */
    }
  }
  return null;
}

/** persona resolution: explicit > mission.pack.persona > agent_type role file > null */
function resolveDispatchPersona(mission, explicit) {
  if (explicit != null && String(explicit).trim() !== "") {
    const p = path.resolve(projectDir, String(explicit).trim());
    if (!fs.existsSync(p) || !fs.statSync(p).isFile()) {
      throw new ToolError(`persona_path 不可读：${displayPath(p)}`);
    }
    return p;
  }
  if (mission.pack && mission.pack.persona) {
    const p = path.isAbsolute(String(mission.pack.persona))
      ? String(mission.pack.persona)
      : path.resolve(projectDir, String(mission.pack.persona));
    try {
      if (fs.statSync(p).isFile()) return p;
    } catch {
      /* fall through: a stale registration must not block the role match */
    }
  }
  // v1.5 W2-A 拆分重锚注记：本模块三处插件根锚（agents/、hooks/bg-sentinel.mjs、hooks/dispatch-runner.mjs）
  // 均经 path.dirname(fileURLToPath(import.meta.url))+"../.."——模块自 mcp/ 迁 mcp/tool-dispatch/ 深一层，".."→"../.."后解析结果=拆分前同一插件根绝对路径（零行为变更）。
  const bare = dispatchRoleBare(mission.agent_type);
  if (DISPATCH_ROLE_PERSONAS.includes(bare)) {
    const p = path.join(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../.."), "agents", `${bare}.md`);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

/** Strip YAML frontmatter (RP-8 same rule: the body is the persona text). */
function stripPersonaFrontmatter(text) {
  const s = String(text ?? "").replace(/\r\n?/g, "\n");
  const lines = s.split("\n");
  if (lines[0].trim() !== "---") return s.trimEnd();
  const close = lines.findIndex((line, i) => i > 0 && line.trim() === "---");
  if (close < 0) return s.trimEnd();
  return lines.slice(close + 1).join("\n").replace(/^\n+/, "").trimEnd();
}

/** dispatch-results/<mission_id>-<startedMs>.index.json presence = previous run finished. */
function dispatchHasResultIndex(resultDir, missionId) {
  const exact = new RegExp(
    "^" + String(missionId).replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "-\\d+\\.index\\.json$",
  );
  try {
    return fs.readdirSync(resultDir).some((name) => exact.test(name));
  } catch {
    return false;
  }
}

/** Q2 O10=a（v1.2 M3-1）busy 闸超龄豁免阈值（分钟）：env
 *  ORCH_DISPATCH_BUSY_STALE_MIN 可调，默认 120（2h 起步）。 */
function dispatchBusyStaleMin() {
  const raw = Number(process.env.ORCH_DISPATCH_BUSY_STALE_MIN);
  return Number.isFinite(raw) && raw > 0 ? raw : 120;
}

/** 某 mission 的派发侧车盘点（文件系统事实，免 board 解析——O10=a 时间锚）：
 *  dispatch-results/<id>-*（index/error 家族）∪ dispatch-logs/<id>-*
 *  （prompt + runner.log——runner 起手即写 log，prompt 由 server 同步段落盘，
 *  两者任一在场即证明 dispatch 工具同步段真实跑过）。 */
function dispatchMissionSidecars(missionId) {
  const pre = String(missionId) + "-";
  const dirs = [
    path.join(root, "context", "dispatch-results"),
    path.join(root, "context", "dispatch-logs"),
  ];
  const out = [];
  for (const dir of dirs) {
    let names = [];
    try {
      names = fs.readdirSync(dir);
    } catch {
      names = [];
    }
    for (const name of names) {
      if (!name.startsWith(pre)) continue;
      try {
        out.push({ dir, name, mtimeMs: fs.statSync(path.join(dir, name)).mtimeMs });
      } catch {
        /* vanished → ignore */
      }
    }
  }
  return out;
}

/** Q2 归因字段值源（v1.2 M3-1）：派发时主控会话 id 锚 =
 *  <root>/sentinel/coord-session.txt（resume 通道刷新，bg-sentinel 同款消费面）。
 *  best-effort：缺文件/空内容 → null（W9 scoping 空值三段的「前向归因缺席」回落，
 *  消费端按缺席语义处理，此处不造值）。 */
function dispatchCoordSessionId() {
  try {
    const v = fs.readFileSync(path.join(root, "sentinel", "coord-session.txt"), "utf8").trim();
    return v || null;
  } catch {
    return null;
  }
}

/** v1.2 M9-1（§6.2a 空值归因硬约束件·无条件）：组包尾块缺席计数——统计「哨兵本应产生
 * 盯守条件、但归因缺席将被 scoping 跳过」的在盯 mission 数。watchable 集合镜像
 * bg-sentinel classify 条件集（C1=终态+dispatch.agent_id+未签收+非 workflow；
 * C2/C3=在飞+dispatch.agent_id——均要求 agent_id，headless 在飞无 agent 本就不产条件）；
 * 归因=dispatch.session_id ∥ dispatch.spawned_by_session（W3 M3-1 前向归因字段）。
 * selfMissionId=本次派发的 mission：其 spawned_by_session 在同步段随 upsert 落盘，
 * 锚在场即有归因（不计入）；锚缺失则计入（如实呈现最坏面，不因组装时序低估）。
 * 板不可读 → 0（计数是呈现面非门禁，不阻塞派发）。 */
function dispatchScopingAbsentCount(selfMissionId) {
  try {
    const board = JSON.parse(fs.readFileSync(path.join(root, "board.json"), "utf8"));
    const missions = board && Array.isArray(board.missions) ? board.missions : [];
    const anchor = dispatchCoordSessionId();
    const inFlight = (s) => s === "dispatched" || s === "running" || s === "resumed";
    const result = (s) => s === "done" || s === "failed" || s === "blocked" || s === "question";
    let n = 0;
    for (const m of missions) {
      if (!m || typeof m !== "object") continue;
      const d = m.dispatch && typeof m.dispatch === "object" ? m.dispatch : {};
      if (d.mode === "workflow") continue; // B4：workflow 由宿主通知，哨兵不盯守
      const status = String(m.status ?? "");
      const watchable =
        Boolean(d.agent_id) &&
        (inFlight(status) || (result(status) && !(m.ack && typeof m.ack === "object")));
      if (!watchable) continue;
      const sid = typeof d.session_id === "string" ? d.session_id.trim() : "";
      const spawned = typeof d.spawned_by_session === "string" ? d.spawned_by_session.trim() : "";
      if (sid || spawned) continue; // 有归因 → 等值判定照常，不计缺席
      if (selfMissionId != null && String(m.id) === String(selfMissionId)) {
        if (!anchor) n += 1; // 自 mission：锚缺失时同步段的 spawned_by_session 也将为 null
        continue;
      }
      n += 1;
    }
    return n;
  } catch {
    return 0; // 板不可读 → 0（呈现面非门禁）
  }
}

/** v1.2 M9-1 触发面②（复活/自补员·派发前探活）：headless dispatch 同步段内探活——
 * 家族全灭（无任一 fresh 槽位）时补员拉起 bg-sentinel（「无哨兵不派发」语义在既有
 * headless 派发面的落地；W5 组装出口后续接同探活）。判活=pid 存活 ∧ 心跳（heartbeatAt
 * 回落 mtime）龄 ≤ SENTINEL_HEARTBEAT_STALE_MS（与 bg-gate sentinelAlive 同规）；
 * 拉起数量=cfg family_size（缺省 3，1..5 钳制），多余实例由槽位 wx 认领仲裁自然让位
 * 退出（幂等，重复触发无害）。best-effort：任何异常只返回 false，不阻塞派发。 */
function sentinelFamilyAlive() {
  try {
    const sentDir = path.join(root, "sentinel");
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
        if (Math.max(0, age) <= SENTINEL_HEARTBEAT_STALE_MS) return true;
      } catch {
        /* bad slot file → next */
      }
    }
  } catch {
    /* no sentinel dir → family dead */
  }
  return false;
}

function ensureSentinelFamily() {
  try {
    if (sentinelFamilyAlive()) return false;
    const script = path.join(
      path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../.."),
      "hooks",
      "bg-sentinel.mjs",
    );
    let familySize = 3;
    try {
      const cfg = JSON.parse(fs.readFileSync(path.join(root, "sentinel.cfg.json"), "utf8"));
      if (cfg && Number.isFinite(cfg.family_size)) {
        familySize = Math.min(5, Math.max(1, Math.round(cfg.family_size)));
      }
    } catch {
      /* 无/坏 cfg → 内建缺省 3 */
    }
    for (let k = 0; k < familySize; k++) {
      try {
        child_process
          .spawn(process.execPath, [script, "--root", root], { detached: true, stdio: "ignore", windowsHide: true })
          .unref();
      } catch {
        /* best effort */
      }
    }
    return true;
  } catch {
    return false;
  }
}

function dispatchSleepSync(ms) {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      /* spin fallback */
    }
  }
}

function dispatchRolloutSnapshot() {
  try {
    return new Set(fs.readdirSync(harvestRolloutDir()).filter((n) => /^model-io-.+\.jsonl$/.test(n)));
  } catch {
    return new Set();
  }
}

/** Rollout diff scan (no sleeping): newest new model-io file's stem, or null. */
function dispatchRolloutFreshPick(before) {
  const dir = harvestRolloutDir();
  let fresh = [];
  try {
    fresh = fs.readdirSync(dir).filter((n) => /^model-io-.+\.jsonl$/.test(n) && !before.has(n));
  } catch {
    fresh = [];
  }
  let pick = null;
  let pickM = -Infinity;
  for (const name of fresh) {
    try {
      const m = fs.statSync(path.join(dir, name)).mtimeMs;
      if (m >= pickM) {
        pickM = m;
        pick = name;
      }
    } catch {
      /* vanished → ignore */
    }
  }
  return pick ? pick.slice("model-io-".length, -".jsonl".length) : null;
}

/** Result-dir diff scan (no sleeping): this dispatch's fresh runner outcome
 *  files. The busy gate only counts index files, so the dir may still hold a
 *  PREVIOUS run's error/index for the same mission — everything returned here
 *  appeared after `before` was snapshotted (pre-spawn, inside the lock). */
function dispatchScanNewResults(resultDir, before, missionId) {
  const indexRe = new RegExp(
    "^" + String(missionId).replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "-\\d+\\.index\\.json$",
  );
  const errorRe = new RegExp(
    "^" + String(missionId).replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "-.+\\.error\\.json$",
  );
  let names = [];
  try {
    names = fs.readdirSync(resultDir);
  } catch {
    names = [];
  }
  let indexPath = null;
  let errorPath = null;
  let indexM = -Infinity;
  let errorM = -Infinity;
  for (const name of names) {
    if (before.has(name)) continue;
    const full = path.join(resultDir, name);
    let m = -Infinity;
    try {
      m = fs.statSync(full).mtimeMs;
    } catch {
      /* vanished → ignore */
    }
    if (indexRe.test(name) && m >= indexM) {
      indexM = m;
      indexPath = full;
    } else if (errorRe.test(name) && m >= errorM) {
      errorM = m;
      errorPath = full;
    }
  }
  return { indexPath, errorPath };
}

/** Capture window for the combined poll (v1.1.1-FA): default 8000ms — the R2
 *  fast-death run died at 4.8s, comfortably inside; test seam via env. */
function dispatchCaptureWindowMs() {
  const raw = Number(process.env.ORCH_DISPATCH_CAPTURE_MS);
  if (Number.isFinite(raw) && raw >= 500) return Math.min(Math.floor(raw), 30000);
  return 8000;
}

/** Error summary + human hint for a runner-recorded failure (v1.1.1-FA task 2:
 *  消灭 ok-但-没拉起的静默面 — R2 findings P2). Reads the error sidecar's log
 *  tail and surfaces the last `Error:` line verbatim. */
function dispatchFailureSummary(errorPath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(errorPath, "utf8"));
    const tail = String(parsed.log_tail || "");
    const lines = tail.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    const errLine =
      [...lines].reverse().find((l) => l.startsWith("Error:")) ||
      lines[lines.length - 1] ||
      String(parsed.error || "runner 记录失败（日志尾为空）");
    return {
      error: errLine.slice(0, 300),
      modelError: /Select a model/i.test(tail),
      // v1.3 W5 F-C8 分类面：modelCongested 与 modelError 并列返回。白名单显式模式
      // （design §3.5 逐字，禁裸猜）：1305/429 拥塞限流码＋overloaded＋rate limit。
      // F2 校准（2026-11-01，真实样本=m-20261027-182625-fb8d error 侧车，
      // l-20261027-ad8a34 同事件族：providerCode '1302'＋providerMessage
      // 「您的账户已达到速率限制」＋responseStatus: 429，tail_len 3800 < 窗宽 16384
      // 落窗实证）：base 正则经 429 命中真实拥塞形态族；1305 形态零样本=候补登记
      // （v1.3.0.md W5 节）；误报样本（worker 报告正文提及 429）=design §3.5 已披露
      // 误判面，TTL 30min＋字段全透明＋kill switch 三重兜。
      modelCongested: /1305|429|overloaded|rate.?limit/i.test(tail),
    };
  } catch {
    return { error: "error 侧车不可读：" + errorPath, modelError: false, modelCongested: false };
  }
}

/** v1.1.1-FA combined capture (≤8s default): poll BOTH faces each 100ms tick —
 *  (a) rollout diff: a fresh model-io file = the -p session booted (success,
 *  may long precede process exit); (b) dispatch-results diff: the runner's
 *  index/error sidecars (fast death lands here — R2 measured 4.8s). Outcomes:
 *  {kind:"session", sessionId} | {kind:"failed", errorPath, exitCode} |
 *  {kind:"pending"} (true slow-start keeps the session_pending contract). */
function dispatchCaptureOutcome(opts) {
  const { rolloutBefore, resultsBefore, resultDir, missionId, waitMs } = opts;
  const deadline = Date.now() + waitMs;
  for (;;) {
    const sessionId = dispatchRolloutFreshPick(rolloutBefore);
    if (sessionId) return { kind: "session", sessionId };
    const hit = dispatchScanNewResults(resultDir, resultsBefore, missionId);
    if (hit.indexPath) {
      let idx = null;
      try {
        idx = JSON.parse(fs.readFileSync(hit.indexPath, "utf8"));
      } catch {
        idx = null;
      }
      if (idx && typeof idx.session_id === "string" && idx.session_id) {
        return { kind: "session", sessionId: idx.session_id };
      }
      if (idx) {
        return {
          kind: "failed",
          errorPath: idx.error_path || hit.errorPath || null,
          exitCode: Number.isFinite(idx.exit_code) ? idx.exit_code : null,
        };
      }
    }
    if (hit.errorPath) return { kind: "failed", errorPath: hit.errorPath, exitCode: null };
    if (Date.now() >= deadline) return { kind: "pending" };
    dispatchSleepSync(100);
  }
}

/* ------------------------------------------------------------------ */
/* v1.1.1-FA: headless model supply (dispatch bug fix, R2 P1 root cure). */
/* v1.2.3 W2 (2026-10-30): seeding rewritten to two-source fast-fail    */
/* (explicit model= / session truth; selection-class rejections return  */
/* a structured rejected+guidance receipt and spawn nothing) — see the  */
/* pick/seed docstrings below. This block keeps the archaeology that    */
/* justifies the account no-seed ruling and the -p supply chain.        */
/*                                                                     */
/* Archaeology anchors (0.17.0 byte offsets kept where still valid —    */
/* 0.17.1 increments are not public source, offsets may drift):         */
/*   - throw site @13549646: CliDefaultSelection.prepareInput —        */
/*     `n = t?.intent?.modelSelection ?? this.get(); if(!n) throw ...` */
/*     ("Select a model before sending a message"). Still the -p death */
/*     cause whenever no model can be seeded.                           */
/*   - -p supply chain: y3n runPrompt @15172709 → DAt @14470771        */
/*     startProcessProviderRegistryRuntime → H1r @1154821 resolves the  */
/*     env pair ZCODE_BUILTIN_PROVIDER_CONFIG_FILE +                    */
/*     ZCODE_PERSONAL_PROVIDER_CONFIG_FILE (BOTH required, else hard    */
/*     error) → personal provider config (default provider_config.json  */
/*     next to credentials.json).                                       */
/*   - ERA mechanism CORRECTED (survey §2.1/§2.3, 2026-10-30): -p has   */
/*     NO registry child process — NodeProviderRegistryRuntime runs     */
/*     IN-PROCESS ([TS][BUNDLE]); the earlier "registry spawns a child" */
/*     attribution was wrong. ERA_NEGOTIATION_FAILED is the MCP         */
/*     `server/discover` version-negotiation probe (a one-shot sibling  */
/*     process) failing to connect — a SECONDARY unhandled exception    */
/*     that fires only AFTER the "Select a model" crash (log timeline   */
/*     evidence). Version difference flagged: 0.16.2 has NO             */
/*     server/discover face at all, so the ERA probe window is a        */
/*     0.17.x-only surface; the .mcp.json protocolVersion:"legacy" line */
/*     (v1.2.3 M3) removes the probe window entirely.                   */
/*   - H1 signing chain (survey §3.2; evidence level [BUNDLE], NOT      */
/*     live-verified): 0.17.1 closed-source additions introduce         */
/*     ClientRequestSigningV4Manager + X-ZCode-Authorization header +   */
/*     /api/v1/ultra gateway route, activating for zhipu-account        */
/*     individual/team-coding-plan access — the most plausible cause of */
/*     the unusual-activity risk-control rejections.                    */
/*   - --json envelope change (0.17.1): single-line → multi-line pretty */
/*     JSON (650B measured fixture; fields sessionId/traceId/turnId/    */
/*     response/usage/eventCount/projection). Runner-side compat = the  */
/*     v1.2.3 W1 dual-channel parseEnvelope (channel B accumulates).    */
/*   - schema @619452/527943: strict zod — `config.defaultModelSelection*/
/*     = {providerId, modelId, options:{reasoningLevel}}`; ANY unknown */
/*     key recovers the WHOLE config to empty (silent!), so the seed   */
/*     must match the schema exactly.                                  */
/*   - resolution xet @596667: configured-default (selectable check    */
/*     Xme @594786 REQUIRES options.reasoningLevel) → registry-fallback*/
/*     (first selectable model) → none = the prepareInput throw.       */
/*   - account no-seed ruling (2026-10-30, user): account (zhipu-       */
/*     account) providers have no desktop entitlement in standalone and */
/*     NEVER resolve — seeding must reject them explicitly with         */
/*     actionable guidance instead of guessing; self-contained api-key  */
/*     providers work (three-model empirical pass, 2026-10-27).         */
/* Empirics (2026-10-26, this install): a bare -p probe fails in EVERY */
/* workspace (the R2 "probe workspace works" premise expired). Seeding  */
/* an env-redirected COPY (original file never touched) with an enabled */
/* api-key provider + enabled model + defaultModelSelection was verified*/
/* end-to-end: the probe returned a full --json envelope (response "ok").*/
/* ------------------------------------------------------------------ */

/** Env pair for the CLI's provider-config face (empty string = absent). */
function dispatchProviderConfigEnv() {
  const personal = String(process.env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE || "").trim();
  const builtin = String(process.env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE || "").trim();
  return { personal, builtin, pair: Boolean(personal && builtin) };
}

function dispatchSeedModelConfig(missionId, modelArg) {
  const envp = dispatchProviderConfigEnv();
  if (!envp.pair) {
    return { seeded: false, reason: "env_pair_missing" };
  }
  let doc;
  try {
    doc = JSON.parse(fs.readFileSync(envp.personal, "utf8"));
  } catch {
    return { seeded: false, reason: "personal_config_unreadable" };
  }
  if (!doc || typeof doc !== "object" || !doc.config || typeof doc.config !== "object") {
    return { seeded: false, reason: "personal_config_shape" };
  }
  const pick = dispatchPickSeedModel(doc, modelArg);
  if (pick && pick.reject) {
    // v1.2.3 W2: selection-class rejection (§12 form, dispatch EXTRA① confirmed)
    // — toolDispatchInner forks BEFORE board upsert / prompt sidecar / spawn:
    // no -p process, no sidecars, mission stays drafted for re-dispatch. The
    // receipt rides model_seed{seeded:false, reason, rejected, guidance,
    // available_apikey_providers}. reason dual-write per draft §P3 mapping
    // (account leg keeps model_arg_unusable verbatim — FA-3 hard anchor);
    // env-chain/shape/write failures below never carry rejected/guidance
    // (non-selection class, two guidance lines do not apply).
    return {
      seeded: false,
      reason: pick.reason || pick.reject.kind,
      rejected: pick.reject,
      guidance: [
        '显式传 model="<providerId>/<modelId>[@level]"（api-key 型 provider）',
        "请用户在宿主启用目标 api-key provider，使会话 defaultModelSelection 可采信",
        // v1.4 D3 拒种 guidance 背书（design §1.10 逐字稿；三拒绝腿 account 前缀/account
        // access.type/dms_provider_account 同批共享本构造点，M-2/M-b 同文裁）：
        "（实证背书 2026-11-02）CLI 选型层已证账号型目标不可选：defaultModelSelection 指向账号型被无视/过滤（α「Select a model」零请求死、β 静默回落 api-key；见 v1.4 qa/d1-finding.md）——解除禁种在 CLI 层无技术意义。",
        "账号型需求走 nested 主形态（宿主按 subagent_type 加载角色定义；嵌套转发 prompt 系模型逐字转录）；CLI 选型层改造候选已记 patcher 项目 backlog。",
      ],
      available_apikey_providers: dispatchListApikeyProviders(doc, 3),
    };
  }
  if (!pick || pick.unusable) {
    // model_arg_unusable kept verbatim (explicit-negative semantics, FA-3
    // sibling leg DS-08: no rejected field, boot-then-die unchanged). The old
    // no_apikey_model literal is retired with stage-③'s deletion — its scene
    // (no model=, no dms, fallthrough) now returns selection_missing above.
    return { seeded: false, reason: "model_arg_unusable" };
  }
  // v1.3 W5 F-C8 拥塞降级选型（design §13.2-2 两源形态重述——候选序=显式 model 与
  // dms 两源内展开；段③「首 api-key 猜测」已删、「api-key 序列下一位」前提失效，
  // 不复活）：首选在戳 → 跳另一源候选；全部候选在戳 → 照旧首选＋congestion_skipped_all
  // 警示字段。kill switch=ORCH_DISPATCH_CONGESTION_OFF（跳选+写戳双面停用）；零戳=
  // 零行为差（回归基线）。自动重派不做（N-3 红线）：降级只发生在重派后的下一次播种。
  let picked = pick;
  let congestion = null;
  if (!dispatchCongestionOff()) {
    const stamp = dispatchCongestionRead();
    const primaryPair = pick.providerId + "/" + pick.modelId;
    if (dispatchCongestionStamped(stamp, primaryPair)) {
      const skipped = [primaryPair];
      // 次选=另一源候选：modelArg 在场 → dms 源（dms 缺席/校验失败=无次选，不猜）；
      // modelArg 缺席 → 首选已来自 dms 源，无第二源。
      const alt = modelArg ? dispatchPickSeedModel(doc, null) : null;
      const altPair =
        alt && !alt.reject && !alt.unusable && alt.providerId
          ? alt.providerId + "/" + alt.modelId
          : null;
      if (altPair && altPair !== primaryPair && !dispatchCongestionStamped(stamp, altPair)) {
        picked = alt;
        congestion = { congestion_skipped: skipped, downgraded_to: altPair };
      } else {
        if (altPair && altPair !== primaryPair) skipped.push(altPair);
        congestion = { congestion_skipped: skipped, congestion_skipped_all: true };
      }
    }
  }
  // v1.2.3 W2: level_warning — advisory only (提示非门禁): an explicit @level
  // outside the model's own optionSpecs values is the user's call (裁定③
  // 显式意志采信；实测 not selectable 是其后果), surfaced so the coordinator can
  // self-correct. Attached only when optionSpecs are queryable and the explicit
  // level misses the values domain; dms-sourced levels never warn (宿主真值).
  let levelWarning = null;
  if (picked.levelExplicit && picked.reasoningLevel != null) {
    const entry = ((doc.config.modelConfigRules && doc.config.modelConfigRules.providerModelRules) || []).find(
      (r) => r && r.providerId === picked.providerId && r.modelId === picked.modelId,
    );
    const values =
      entry && entry.config && entry.config.optionSpecs && entry.config.optionSpecs.reasoningLevel &&
      Array.isArray(entry.config.optionSpecs.reasoningLevel.values)
        ? entry.config.optionSpecs.reasoningLevel.values
        : null;
    if (values && !values.includes(pick.reasoningLevel)) {
      levelWarning =
        "显式 @" + picked.reasoningLevel + " 不在 " + picked.providerId + "/" + picked.modelId +
        " 的 optionSpecs.reasoningLevel 值域 [" + values.join("/") + "] 内——未拦截（显式意志采信），实测 not selectable 时请改传有效档位";
    }
  }
  try {
    const seedDoc = JSON.parse(JSON.stringify(doc));
    const rules = seedDoc.config.providerConfigRules.providerRules;
    const rule = rules.find((r) => r && r.providerId === picked.providerId);
    if (rule && rule.config) {
      if (!Array.isArray(rule.config.personalModelIds)) rule.config.personalModelIds = [];
      if (!rule.config.personalModelIds.includes(picked.modelId)) rule.config.personalModelIds.push(picked.modelId);
      if (!Array.isArray(rule.config.modelOrder)) rule.config.modelOrder = [];
      if (!rule.config.modelOrder.includes(picked.modelId)) rule.config.modelOrder.push(picked.modelId);
    }
    // Object-presence guards — modelConfigRules is an OBJECT in the real
    // schema ({providerModelRules, manualProviderModelRules}); an Array.isArray
    // check here would be always-false and silently WIPE every existing rule.
    if (!seedDoc.config.modelConfigRules || typeof seedDoc.config.modelConfigRules !== "object" || Array.isArray(seedDoc.config.modelConfigRules)) {
      seedDoc.config.modelConfigRules = {};
    }
    if (!Array.isArray(seedDoc.config.modelConfigRules.providerModelRules)) {
      seedDoc.config.modelConfigRules.providerModelRules = [];
    }
    const entry = seedDoc.config.modelConfigRules.providerModelRules.find(
      (r) => r && r.providerId === picked.providerId && r.modelId === picked.modelId,
    );
    if (entry) {
      if (!entry.config || typeof entry.config !== "object") entry.config = {};
      entry.config.enabled = true; // copy-only flip: the original file is untouched
    } else {
      seedDoc.config.modelConfigRules.providerModelRules.push({
        modelId: picked.modelId,
        config: { enabled: true },
        providerId: picked.providerId,
      });
    }
    // defaultModelSelection only when the level is KNOWN-VALID (explicit
    // @level or the model's own declared optionSpecs values — FA bisect:
    // an injected optionSpecs pin made the whole config recover to empty,
    // so the seed never writes optionSpecs itself). Without a dms the CLI's
    // registry-fallback (xet @596667 → gQi values.at(-1)) picks the enabled
    // model with a valid level — empirically verified end-to-end.
    // Q1（v1.2 M3-1）：fromDms 命中时跳过覆写——种子拷贝自带会话真值
    // defaultModelSelection（宿主原样，strict-zod 已被真实配置自证），任何重写
    // 都是画蛇添足；覆写仅在回落分支（显式 model / 首 api-key）生效，顺带把
    // 指向 disabled provider 的陈旧 dms 换成有效选型。
    if (!picked.fromDms && picked.reasoningLevel != null) {
      seedDoc.config.defaultModelSelection = {
        providerId: picked.providerId,
        modelId: picked.modelId,
        options: { reasoningLevel: picked.reasoningLevel },
      };
    }
    const seedPath = path.join(root, "context", "dispatch-model-seed", `${missionId}.json`);
    atomicWriteFileSync(
      seedPath,
      JSON.stringify(seedDoc, null, 2) + "\n",
    );
    return {
      seeded: true,
      provider_id: picked.providerId,
      model_id: picked.modelId,
      reasoning_level: picked.reasoningLevel,
      config_path: seedPath,
      ...(levelWarning ? { level_warning: levelWarning } : {}),
      ...(congestion ? congestion : {}),
    };
  } catch (err) {
    return { seeded: false, reason: "seed_write_failed:" + String((err && err.message) || err).slice(0, 120) };
  }
}

function toolDispatchInner(args) {
  const missionId = safeSegment(args.mission_id, "mission_id");
  // v1.2 M5-1：mode 参数（缺省 headless——-p 链既有语义零触碰；"nested"=组装出口，
  // 不 spawn 进程、返 {mission_id, token, prompt, pack_path} 由主控经宿主 Agent 嵌套发出）。
  const dispatchMode = args.mode == null || args.mode === "" ? "headless" : String(args.mode);
  if (dispatchMode !== "headless" && dispatchMode !== "nested") {
    throw new ToolError(`dispatch mode 非法：${dispatchMode}（enum: headless|nested）`);
  }
  const mission = findMission(loadBoard(), missionId);
  if (!mission) {
    throw new ToolError(`mission 不在板：${missionId}（先 board upsert + context_pack）`);
  }
  const status = String(mission.status ?? "");
  // v1.3 WG G-a (O13-a): the dispatch gate now accepts ready as well. The
  // transitions table already allowed ready→dispatched (server-board
  // ALLOWED_TRANSITIONS — zero change here) and the pool-claim face already
  // consumed drafted/ready (zero change) — dual consumption channels, no
  // semantic conflict; this closes the ready-trap (dispatch gate was the
  // single conflicting point, l-20261027-9908d0 family).
  if (status !== "drafted" && status !== "dispatched" && status !== "ready") {
    throw new ToolError(`mission 状态 ${status} 不可派发（dispatch 只接受 drafted/dispatched/ready）`);
  }
  // §1.6 yolo 闸：只读/记忆域 persona 豁免；worker 类必须登记非空写集。
  const bareRole = dispatchRoleBare(mission.agent_type);
  const scope = Array.isArray(mission.scope_paths) ? mission.scope_paths.filter(Boolean) : [];
  if (!DISPATCH_READONLY_ROLES.has(bareRole) && scope.length === 0) {
    throw new ToolError(
      "yolo 闸：worker 类 mission 的 scope_paths 为空——headless 子代理=--mode yolo 全放行，" +
        "必须先登记写集 scope_paths（越界可审计），或改走宿主 Agent 通道",
    );
  }
  const resultDir = path.join(root, "context", "dispatch-results");
  // Q2 O10=a（v1.2 M3-1）超龄豁免：结果 index 缺席时盘点侧车——全部超龄（>阈值）
  // → 放行重派并附 warning（孤儿会话风险提示）。判据不取「侧车全无」腿：零侧车=
  // dispatch 同步段从未跑过（含手写 mode=headless 的板记录，l-20261026-792cf9 形态），
  // never-dispatched ≠ 孤儿，维持拒双跑（crv2 W4-DISPATCH-08 黑盒语义保持）。
  // 真在飞 mission 必有新鲜侧车（log runner 起手即写 / prompt server 同步段先写），
  // 不会被误放行。killed-index（runner 死亡兜底）落真 index 文件名 → 先于豁免放行。
  let busyExempt = null;
  if (
    mission.dispatch &&
    mission.dispatch.mode === "headless" &&
    !dispatchHasResultIndex(resultDir, missionId)
  ) {
    const staleMin = dispatchBusyStaleMin();
    const sidecars = dispatchMissionSidecars(missionId);
    const cutoff = Date.now() - staleMin * 60000;
    const allStale = sidecars.length > 0 && sidecars.every((sc) => sc.mtimeMs <= cutoff);
    if (!allStale) {
      throw new ToolError(
        `busy 闸：mission ${missionId} 已有 headless 派发在飞（dispatch-results 无结果 index），拒双跑`,
      );
    }
    busyExempt = { stale_min: staleMin, sidecars: sidecars.length };
  }
  // v1.2 M5-1 nested busy 闸分叉（板语义，不消费 result-dir index——result-dir 三件套对
  // nested 整体缺席，headless 闸上块的 mode 判据天然不消费 nested mission）。在飞判定=
  // 组装凭据已交付主控（宿主 Agent 嵌套发出）而 worker 结果尚未落板（status 仍
  // dispatched）——拒二次组装防双发；running 已被上方状态闸拦（board running+claim
  // 租约语义）。恢复路径=主控会话内可见首 Agent 已死时 board upsert status:"drafted"
  // （dispatched→drafted 合法腿）后重派，或等 worker report 演进状态。
  if (mission.dispatch && mission.dispatch.mode === "nested" && status === "dispatched") {
    throw new ToolError(
      `busy 闸（nested）：mission ${missionId} 已有 nested 组装凭据在飞（board dispatched、` +
        "worker 结果未落板），拒二次组装——恢复：首个嵌套 Agent 已死时 " +
        'board upsert status:"drafted"（dispatched→drafted 合法腿）后重派，或等 worker report',
    );
  }
  const packFile = resolveDispatchPack(mission, args.pack_path);
  if (!packFile) {
    throw new ToolError(
      `任务包不可读：mission.pack.path / pack_path / ${displayPath(path.join(root, "packs", missionId, "pack.md"))} 三级均未命中`,
    );
  }
  let packText;
  try {
    packText = fs.readFileSync(packFile, "utf8");
  } catch (err) {
    throw new ToolError(`任务包读取失败：${displayPath(packFile)}（${err && err.message ? err.message : err}）`);
  }
  const personaFile = resolveDispatchPersona(mission, args.persona_path);
  if (!personaFile) {
    throw new ToolError(
      "persona 未解析：显式传 persona_path，或先在 context_pack 登记 persona_path，" +
        `或让 mission.agent_type 精确命中六角色之一（${DISPATCH_ROLE_PERSONAS.join("/")}）`,
    );
  }
  const personaText = stripPersonaFrontmatter(fs.readFileSync(personaFile, "utf8"));
  const dispatchLogFile = path.join(root, "context", "coord-tail-log.md");
  let logText = "";
  try {
    logText = fs.readFileSync(dispatchLogFile, "utf8");
  } catch {
    logText = ""; // no log yet → trace section absent
  }
  const sandbox = mission.pack && mission.pack.sandbox;
  let cwd = projectDir;
  if (sandbox && sandbox.isolation === "worktree") {
    const sandboxRoot = String(sandbox.root || "");
    if (!sandboxRoot || !fs.existsSync(sandboxRoot)) {
      throw new ToolError(`沙箱工作区不可用：${sandboxRoot || "(空)"}（worktree 丢失，先 sandbox_discard 重派）`);
    }
    cwd = sandboxRoot;
  }
  // Sandbox cwd ≠ projectDir → the pointer must be absolute (DESIGN §1.3: pack
  // is Read via absolute path inside the worktree); in-repo dispatch keeps the
  // coordinator-facing display path.
  const promptPackPath = cwd === projectDir ? displayPath(packFile) : path.resolve(packFile);
  const promptMission = { ...mission, pack: { ...(mission.pack || {}), path: promptPackPath } };
  // v1.2 M9-1：组包尾块缺席计数随 scoping 参数入纯区组装（计数在纯区外预算——纯区零 fs）。
  // v1.4 A1 免烘（design §1.1 甲方案）：typed:true ∧ nested → personaText 传位改为
  // resolveDispatchPersona 返回的绝对路径（纯区注入点改组两行指针行）；headless 恒全文
  // （-p 无 subagent_type 加载面）；缺省全烘字节一致。mode 随 scoping 传位（调用方预算）。
  const typedRequested = args.typed === true;
  const personaPointerMode = typedRequested && dispatchMode === "nested";
  const built = buildDispatchPrompt(
    promptMission,
    packText,
    logText,
    personaPointerMode ? personaFile : personaText,
    dispatchDigestRead(),
    { absent: dispatchScopingAbsentCount(missionId), mode: dispatchMode },
    typedRequested,
  );
  if (!built.ok) throw new ToolError(built.error);

  // v1.2 M5-1 mode=nested 组装出口（主形态；aggregated §5）：不 spawn 进程——组包链
  // 复用（pack.md 唯一世界、buildDispatchPrompt 同一纯区组装、零新协议），组装好的
  // 首条消息返主控，由主控经宿主 Agent 嵌套发出。本分支纯新增，default（headless）
  // -p 链以下逐字节不变。嵌套形态下 bg-gate 对宿主 Agent 调用只是提示面非防线
  // （PT-5 fail-open 三层，且不知 mission scope——§8.7），派发纪律靠本工具面内嵌校验保证：
  //   ① CONTRACT 三行——buildDispatchPrompt ok 即已强制（包 CONTRACT 缺三行在此前抛错）；
  //   ② token 鉴权（p2pTokenGate 同语义落组装面）——包 CONTRACT token 必须 ≡
  //      mission.dispatch.token（context_pack 铸发、report/p2p 闸的 expected token）；
  //      无板 token 且 --strict-tokens → 拒（与 report 闸同向）；
  //   ③ scope_paths 预检——上方 yolo 闸两形态同闸（worker 类非空写集强制）。
  if (dispatchMode === "nested") {
    const boardToken =
      mission.dispatch && mission.dispatch.token ? String(mission.dispatch.token) : null;
    if (boardToken != null) {
      if (built.token !== boardToken) {
        throw new ToolError(
          "组装出口 token 鉴权不过：包 CONTRACT token 与 mission.dispatch.token 不一致" +
            "（重新 context_pack 铸发后重派，或核对 pack_path 指向陈旧包）",
        );
      }
    } else if (strictTokens) {
      throw new ToolError(
        "组装出口 token 鉴权：--strict-tokens 模式下不接受无派发 token 的组装（先 context_pack 铸发 token 再派发）",
      );
    }
    // 审计 prompt 落盘（与 -p 同目录同命名族：组装事实的时间锚，兼作后续 headless
    // 重派时 O10 判据的侧车素材——确有派发发生）。
    const stampN = new Date().toISOString().replace(/[:.]/g, "-");
    const promptPathN = path.join(root, "context", "dispatch-logs", `${missionId}-${stampN}.prompt`);
    atomicWriteFileSync(promptPathN, built.text);
    // 记账（与 headless 同形：mode=nested 先于宿主 Agent 存在即板上可见；
    // spawned_by_session=W3 归因锚消费面；agent_id/task_id/session_id 留 null——
    // 主控在场直收结果，哨兵 classify 要求 agent_id → nested 默认不盯，§5.2.4）。
    upsertMission(
      {
        id: missionId,
        ...(status === "drafted" ? { status: "dispatched" } : {}),
        dispatch: {
          mode: "nested",
          agent_id: null,
          task_id: null,
          session_id: null,
          spawned_by_session: dispatchCoordSessionId(),
        },
      },
      { internal: true },
    );
    // v1.2 M9-1 触发面②（复活/自补员）组装出口接线：「无哨兵不派发」探活复用
    // ensureSentinelFamily（M9-1 既有实现，impl-plan M5-1 task 指定接同探活）。
    ensureSentinelFamily();
    return {
      ok: true,
      mode: "nested",
      mission_id: missionId,
      worker: built.worker,
      channel: built.channel,
      token: built.token,
      prompt: built.text,
      pack_path: displayPath(packFile),
      prompt_path: displayPath(promptPathN),
      chars: built.chars,
      persona: built.persona, // v1.4 A1 组装形态旗标（pointer=免烘指针行|full=全烘）恒在
      __nested: true, // wrapper 消费：nested 无进程可捕获，跳过 ≤8s 组合捕获
    };
  }

  // v1.2.3 W2 (§12 form, dispatch EXTRA① confirmed): the selection-class seed
  // pre-check runs BEFORE the prompt sidecar / board upsert / spawn. A
  // rejection = the mission was never dispatched: ok:true + model_seed
  // {seeded:false, reason, rejected, guidance, available_apikey_providers},
  // zero sidecars (the busy gate stays clear for re-dispatch), no -p process
  // (no ERA surface), board keeps status drafted. Non-selection failures
  // (env chain / config shape / seed write / explicit-model unusable) keep the
  // v1.1.1-FA behavior below: upsert + spawn proceed, runner boots anyway.
  const modelSeed = dispatchSeedModelConfig(missionId, args.model);
  if (modelSeed.rejected) {
    return {
      ok: true,
      mission_id: missionId,
      worker: built.worker,
      channel: built.channel,
      persona: built.persona, // v1.4 A1 组装形态旗标（pointer|full）恒在——拒绝回执亦带组装面
      model_seed: modelSeed,
      __seed_rejected: true, // wrapper consumes: no capture window for a dispatch that never spawned
    };
  }

  const logDir = path.join(root, "context", "dispatch-logs");
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const promptPath = path.join(logDir, `${missionId}-${stamp}.prompt`);
  atomicWriteFileSync(promptPath, built.text);
  const runnerLogPath = path.join(logDir, `${missionId}-${stamp}.runner.log`);
  const runnerPath = path.join(
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../.."),
    "hooks",
    "dispatch-runner.mjs",
  );
  if (!fs.existsSync(runnerPath)) {
    throw new ToolError(`dispatch-runner.mjs 缺失：${displayPath(runnerPath)}`);
  }
  const timeoutMinRaw = Number(args.timeout_min);
  const timeoutMin =
    Number.isFinite(timeoutMinRaw) && timeoutMinRaw > 0
      ? Math.floor(timeoutMinRaw)
      : DISPATCH_DEFAULT_TIMEOUT_MIN;

  // Board first: mode=headless is visible to the busy gate / sentinel before the
  // process exists (the double-dispatch window closed by the lock, not by luck).
  // Q2 归因（v1.2 M3-1）：spawned_by_session=派发时主控会话 id 锚（coord-session.txt
  // best-effort，缺锚=null）——W9 scoping 的前向归因消费面；寄 dispatch/ONE_LEVEL
  // 子键，mergeMission 白名单陷阱不触（R4 低-3 三选一处置：子键方案）。
  upsertMission(
    {
      id: missionId,
      ...(status === "drafted" ? { status: "dispatched" } : {}),
      dispatch: {
        mode: "headless",
        agent_id: null,
        task_id: null,
        session_id: null,
        spawned_by_session: dispatchCoordSessionId(),
      },
    },
    { internal: true },
  );

  // v1.2 M9-1 触发面②：派发前探活补员（「无哨兵不派发」——家族全灭时拉起 bg-sentinel
  // 家族；任一 fresh 槽位在岗即让位，幂等。落本 headless 派发面，W5 组装出口后续接同探活）。
  ensureSentinelFamily();

  // v1.1.1-FA: the model seed was computed BEFORE the prompt/upsert above
  // (in-lock, small file IO; the §12 selection-class fork consumed rejections
  // there). Seed failure is NOT fatal for the non-selection legs (env chain /
  // config shape / seed write / explicit-model unusable) — the runner boots
  // anyway and the combined capture (task 2) turns a fast death into ok:false
  // instead of a silent ok:true+pending (R2 静默失败).
  const resultsBefore = new Set(
    (() => {
      try {
        return fs.readdirSync(resultDir);
      } catch {
        return [];
      }
    })(),
  );
  const rolloutBefore = dispatchRolloutSnapshot();
  const child = child_process.spawn(
    process.execPath,
    [
      runnerPath,
      "--mission-id", missionId,
      "--prompt", promptPath,
      "--cwd", cwd,
      "--result-dir", resultDir,
      "--log", runnerLogPath,
      "--timeout-min", String(timeoutMin),
      ...(modelSeed.seeded ? ["--provider-config-seed", modelSeed.config_path] : []),
    ],
    { detached: true, stdio: "ignore", windowsHide: true, cwd: projectDir },
  );
  // Spawn failures land as an index written by the runner's fail() path
  // (error=runner_early_fail, v1.2 M3-1 Q2 entry-② fix) — the busy gate
  // unblocks on re-dispatch. Residual: a hard kill (taskkill /F) before any
  // handler runs leaves NO index; the gate then holds until the O10
  // stale-sidecar exemption or manual sidecar cleanup. The no-op listener
  // keeps an EMFILE-style error from reaching uncaughtException.
  child.on("error", () => {});
  child.unref();
  return {
    ok: true,
    mission_id: missionId,
    worker: built.worker,
    persona: built.persona, // v1.4 A1 组装形态旗标（pointer|full）恒在；headless 恒 full
    log_path: displayPath(runnerLogPath),
    prompt_path: displayPath(promptPath),
    result_dir: displayPath(resultDir),
    ...(busyExempt
      ? {
          warning:
            `busy 闸超龄豁免放行：结果 index 缺席且全部侧车超龄（>${busyExempt.stale_min}min，` +
            "ORCH_DISPATCH_BUSY_STALE_MIN 可调）——可能有孤儿会话残留，重派前建议核查旧会话",
        }
      : {}),
    __rollout_before: rolloutBefore,
    __results_before: resultsBefore,
    __result_dir_abs: resultDir,
    __model_seed: modelSeed,
  };
}

/** dispatch = lock-held sync段 (gates + board + spawn) then a lock-free ≤8s
 *  combined capture (v1.1.1-FA): rollout session diff OR the runner's result
 *  sidecars. Holding the root lock across the capture would blow the 2s lock
 *  wait for every concurrent tool call. Capture/session回填 failures degrade
 *  to session_pending:true (the result index backfills later); a runner-
 *  recorded fast death now surfaces as ok:false + error + hint instead of the
 *  R2 silent ok:true+pending.
 *  v1.1.1 W-B: the sync-section hold time is measured and returned as
 *  lock_hold_ms (grill#wake Q5: lock-hold-time 断言 <2000ms = 2s 锁预算的黑盒
 *  量测面；断言腿 crv6-statemachine WB-SRV-g). */
function toolDispatch(args) {
  const lockT0 = Date.now();
  const prepared = withRootLock(() => toolDispatchInner(args));
  const lockHoldMs = Date.now() - lockT0;
  // v1.2 M5-1：nested 组装出口无进程可捕获——锁内组装即终态回执，跳过 ≤8s 组合捕获
  //（-p 链捕获面零触碰）。
  if (prepared.__nested) {
    delete prepared.__nested;
    return { ...prepared, lock_hold_ms: lockHoldMs };
  }
  // v1.2.3 W2 (§12)：选择类拒绝=从未派发——无进程无侧车可捕获，跳过 ≤8s 组合捕获，
  // 锁内即终态回执（ok:true + model_seed{seeded:false, reason, rejected, guidance}）。
  if (prepared.__seed_rejected) {
    delete prepared.__seed_rejected;
    return { ...prepared, lock_hold_ms: lockHoldMs };
  }
  const rolloutBefore = prepared.__rollout_before;
  const resultsBefore = prepared.__results_before;
  const resultDirAbs = prepared.__result_dir_abs;
  const modelSeed = prepared.__model_seed;
  delete prepared.__rollout_before;
  delete prepared.__results_before;
  delete prepared.__result_dir_abs;
  delete prepared.__model_seed;
  const outcome = dispatchCaptureOutcome({
    rolloutBefore,
    resultsBefore,
    resultDir: resultDirAbs,
    missionId: prepared.mission_id,
    waitMs: dispatchCaptureWindowMs(),
  });
  if (outcome.kind === "failed") {
    const summary = outcome.errorPath
      ? dispatchFailureSummary(outcome.errorPath)
      : { error: "runner 记录失败（exit_code=" + String(outcome.exitCode) + "，error 侧车缺失）", modelError: false, modelCongested: false };
    // v1.3 W5 F-C8 戳写面（writer）：分类命中 modelCongested → 给本次播种对写拥塞戳
    // （TTL 过期即删+kill switch 全域停断；sentinel/ 目录缺席=跳过，server 恒不创建
    // 该目录——l0 V13 语义保真）。best effort，写戳失败不改变 ok:false 回执形态。
    let stampedPair = null;
    if (summary.modelCongested && modelSeed && modelSeed.seeded && !dispatchCongestionOff()) {
      const pair = modelSeed.provider_id + "/" + modelSeed.model_id;
      if (dispatchCongestionStampPair(pair, dispatchCongestionTtlMin())) stampedPair = pair;
    }
    // Q2 O8=a（v1.2 M3-1）hint 按 index 有无分叉：fail()/killed-index 双入口补写后
    // index 通常已落（旧文案「busy 闸不拦重派」为真）；残余无 index 面（强杀先于全部
    // handler / 历史存量）→ 如实说明 + 解锁指引，不再给出与 busy 闸互斥的指引迷路面。
    // v1.2.3 W2 (PQA3) modelError 分腿：rejected 在场（选择类拒绝）→ 引用
    // rejected.kind+guidance（防御腿——拒绝回执从不 spawn，现势不可达，留此防文案指涉
    // 缺席字段形态）；rejected 缺席（env 链/写盘/provider 不存在的 model_arg_unusable）
    // → 保留 v1.1.1 文案骨架，绝不引用 rejected/guidance。
    // v1.3 W5 (F-C8) modelCongested 分腿（置 modelError 之前——拥塞死亡不走选型供给
    // 文案）：含「已自动降级重选，重派即可」指引；kill switch 在场=如实声明未写戳。
    const hint = summary.modelCongested
      ? modelSeed && modelSeed.congestion_skipped && modelSeed.congestion_skipped.length
        ? "headless 子代理死于模型拥塞（上游 1305/429/overloaded/rate limit）。本次播种已自动降级重选（" +
          modelSeed.congestion_skipped.join("、") + " → " + String(modelSeed.downgraded_to ?? "照旧首选") +
          "），降级后模型仍拥塞；已续写拥塞戳，重派即可（全部候选在戳时照旧首选＋congestion_skipped_all 警示）。"
        : stampedPair
          ? "headless 子代理死于模型拥塞（上游 1305/429/overloaded/rate limit）。已将 " + stampedPair +
            " 写入拥塞戳（TTL " + dispatchCongestionTtlMin() + "min）：下次派发已自动降级重选，重派即可。"
          : "headless 子代理死于模型拥塞（上游 1305/429/overloaded/rate limit）" +
            (dispatchCongestionOff()
              ? "；kill switch（ORCH_DISPATCH_CONGESTION_OFF）在场=拥塞降级停用，未写拥塞戳，请核查模型可用性后重派。"
              : "；本次无播种对可记戳，请核查模型可用性后重派。")
      : summary.modelError
      ? modelSeed.rejected
        ? "headless 子代理未启动：模型选型被播种预检拒绝（" + modelSeed.rejected.kind + "）。" +
          "guidance：" + (modelSeed.guidance || []).join("；") + " 修复后直接重派。"
        : "headless 子代理未启动：CLI 在发消息前要求选模型（该机器 -p 无模型供给）。" +
          "本版 dispatch 已自动播种模型选型副本（见 model_seed 字段）；seeded:false 时请先在桌面/交互模式" +
          "打开该项目 /model 选型并保存为默认，或升级宿主 CLI（上游 -p 缺 --model 旗标）。修复后直接重派。"
      : dispatchHasResultIndex(resultDirAbs, prepared.mission_id)
        ? "headless 子代理未启动（CLI 提前退出）。查 runner 日志（log_path）与 error 侧车（error_path）定位；" +
          "修复后直接重派（结果 index 已落，busy 闸不拦重派）。"
        : "headless 子代理未启动（CLI 提前退出），且结果 index 未落——runner 死亡过快或被强杀，" +
          "busy 闸会拦重派：删除 dispatch-results 中该 mission 的侧车文件后重派，" +
          "或等全部侧车超龄豁免（ORCH_DISPATCH_BUSY_STALE_MIN，默认 120 分钟）。";
    return {
      ...prepared,
      ok: false,
      lock_hold_ms: lockHoldMs,
      error: summary.error,
      hint,
      ...(outcome.errorPath ? { error_path: displayPath(outcome.errorPath) } : {}),
      ...(outcome.exitCode != null ? { exit_code: outcome.exitCode } : {}),
      model_seed: modelSeed,
    };
  }
  const sessionId = outcome.kind === "session" ? outcome.sessionId : null;
  if (sessionId) {
    try {
      withRootLock(() =>
        upsertMission(
          { id: prepared.mission_id, dispatch: { mode: "headless", session_id: sessionId } },
          { internal: true },
        ),
      );
    } catch {
      /* board backfill is best effort: the runner's result index still maps it */
    }
  }
  return {
    ...prepared,
    lock_hold_ms: lockHoldMs,
    model_seed: modelSeed,
    ...(sessionId
      ? { session_id: sessionId }
      : { session_pending: true }),
  };
}

export {
  toolDispatch,
};
