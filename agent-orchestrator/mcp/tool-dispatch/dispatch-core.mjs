// agent-orchestrator orch server — dispatch IO/主流程模块（provenance：v1.5 W2-A T7 裁 a 自 mcp/tool-dispatch.mjs
// 单文件〔1647 行，ece2e80 基〕机械拆分 :302-767+:1045-1643 逐字搬运：resolve/读取+哨兵/组合捕获+provider env+
// 播种配置+toolDispatchInner/toolDispatch 主流程下沉（R1-L3 口径）。本件 > 软帽 900=准入即豁免登记（LM-06-CAP
// OPEN-E 判则 b，G3-3 预填；拆分切面=组装纯区 vs IO 主流程，再下切=主流程手术另案评估）。
// 薄入口=mcp/tool-dispatch.mjs（注册导出接线）。
// v1.6 W-p 剥离波（-p parked）：headless 分支/模型播种/拥塞戳域（原=./dispatch-model.mjs）迁
// parked/agent-orchestrator/（基点快照随 parked README 恢复指引）；mode enum 收窄 ["nested"]。
// v1.6 W3a 组装退役波（R1，design §2.3/impl-plan §2 W3a）：组装链整体退役——./dispatch-prompt.mjs
// 整文件退役（buildDispatchPrompt 组装纯区/BUILD-DISPATCH-PURE 标记区/DISCIPLINE 常量对/预算闸全退）；
// 文件残余下沉本件（dispatchParseContract 供 token 鉴权+回执三元组解析/dispatchRoleBare/DISPATCH_ROLE_PERSONAS/
// DISPATCH_READONLY_ROLES 两常量——逐字搬运；ROLE 两常量收窄〔orch-gleaner 移除〕=v1.6 W3b 已执行）；
// nested 回执编号化（删 prompt 键，终态字段集={ok, mode:"nested", mission_id, worker, channel, token,
// pack_path, lock_hold_ms}；prompt_path/chars/persona 旗标随组装退役一并删除——审计面由 bg-gate 运行时
// CONTRACT 头 presence 检测替代）；首条消息=DP-3 固定指针模板（SKILL §2.3 逐字稿），worker 自取包；
// digest 读取/logText 读取/审计 prompt 落盘/typedRequested 残段删；dispatchScopingAbsentCount/
// dispatchCoordSessionId 下行迁 mcp/server-board.mjs（板域谓词，LM-06-DEP 零登记）。

import fs from "node:fs";
import path from "node:path";
import child_process from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  root, projectDir, safeSegment, ToolError, displayPath, withRootLock,
} from "../server-core.mjs";
import { strictTokens } from "../server-boot.mjs";
import {
  loadBoard, findMission, upsertMission, dispatchCoordSessionId,
} from "../server-board.mjs";
import { SENTINEL_HEARTBEAT_STALE_MS } from "../server-sentinel.mjs";

/* ---- v1.6 W3a R1 下沉区（自 dispatch-prompt.mjs 逐字搬运；文件整退役）----
   DISPATCH_ROLE_PERSONAS/DISPATCH_READONLY_ROLES 两常量收窄=v1.6 W3b 已执行：PERSONAS 收窄至五/
   READONLY 去 gleaner（orch-gleaner persona 件随波删——design §2.1 gleaner 移除联动①②）。 */

const DISPATCH_ROLE_PERSONAS = [
  "orch-worker",
  "orch-scout",
  "orch-reviewer",
  // v1.1.2 I1 双新模板（D2 §5.2/§5.3）：策划/计划均写面（不入 DISPATCH_READONLY_ROLES，
  // yolo 闸 scope_paths 必填）；模板正文见 agents/orch-planner.md / agents/orch-plan.md。
  // v1.6 W3b：orch-gleaner persona 已删除（registry yolo 句同步改双角色——联动四点③）。
  "orch-planner",
  "orch-plan",
];
const DISPATCH_READONLY_ROLES = new Set(["orch-scout", "orch-reviewer"]);

function dispatchRoleBare(agentType) {
  const s = String(agentType ?? "").trim();
  return s.includes(":") ? s.split(":").pop().trim() : s;
}

/** CONTRACT three lines from the pack's CONTRACT section (never re-minted).
 *  v1.6 W3a：唯一消费=token 鉴权+回执 worker/channel/token 三元组（回执编号化——
 *  组装产物无 prompt，主控按 DP-3 固定指针模板机械填充回执字段）。 */
function dispatchParseContract(packText) {
  const lines = String(packText ?? "").split(/\r?\n/);
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^## CONTRACT/.test(lines[i].trim())) {
      start = i;
      break;
    }
  }
  const out = {};
  for (let i = start >= 0 ? start + 1 : 0; i < lines.length; i++) {
    const line = lines[i];
    if (start >= 0 && /^## /.test(line.trim())) break; // section ended
    const m = /^\[(channel|worker|token)\] (.+)$/.exec(line);
    if (m && !Object.prototype.hasOwnProperty.call(out, m[1])) out[m[1]] = m[2].trim();
    if (start < 0 && out.channel && out.worker && out.token) break;
  }
  return out;
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

/** v1.2 M9-1 触发面②（复活/自补员·派发前探活）：nested dispatch 同步段内探活——
 * 家族全灭（无任一 fresh 槽位）时补员拉起 bg-sentinel（「无哨兵不派发」语义；
 * W5 组装出口接线先例）。判活=pid 存活 ∧ 心跳（heartbeatAt 回落 mtime）龄 ≤
 * SENTINEL_HEARTBEAT_STALE_MS（与 bg-gate sentinelAlive 同规）；拉起数量=cfg
 * family_size（缺省 3，1..5 钳制），多余实例由槽位 wx 认领仲裁自然让位退出
 * （幂等，重复触发无害）。best-effort：任何异常只返回 false，不阻塞派发。 */
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

/* v1.6 W-p 剥离：headless ≤8s 组合捕获面（dispatchScanNewResults/dispatchCaptureWindowMs/
   dispatchFailureSummary/dispatchCaptureOutcome）与 v1.1.1-FA 模型供给播种面
   （dispatchProviderConfigEnv/dispatchSeedModelConfig+考古注释块）随 -p 通道整体迁
   parked/agent-orchestrator/（基点快照 a3bb959 可查）。 */

/* v1.6 W3a R1 组装退役：本区原载 logText 读取/dispatchDigestRead/persona 解析链
   （resolveDispatchPersona/stripPersonaFrontmatter）/审计 prompt 落盘/预算闸与组装调用——
   随组装链整体退役（回执编号化：worker 自取包+主控按 DP-3 模板填充，server 零组装文本；
   未取包开工四层防线成文=指针模板「先 Read 任务包 {pack_path}」+CONTRACT 三行内联+
   bg-gate CONTRACT_HEAD presence+persona 预设开工协议 WK-3）。 */

function toolDispatchInner(args) {
  const missionId = safeSegment(args.mission_id, "mission_id");
  // v1.6 W-p 剥离（-p parked）：mode 参数收窄——缺省 "nested"、enum=["nested"]；headless
  // 形态（缺省 -p 链+O10=a busy 闸超龄豁免半区）随 parked/agent-orchestrator/ 迁出
  // （历史 mission 板记录 mode:"headless" 走 board enum 保留面，派发面不再产生 headless 形态）。
  const dispatchMode = args.mode == null || args.mode === "" ? "nested" : String(args.mode);
  if (dispatchMode !== "nested") {
    throw new ToolError(
      `dispatch mode 非法：${dispatchMode}（enum: nested——headless 通道已 parked at v1.6 W-p，archived: parked/agent-orchestrator/）`,
    );
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
  // §1.6 yolo 闸：只读 persona（scout/reviewer）豁免〔v1.6 W3b 起双角色，记忆域 gleaner 件已删〕；worker 类必须登记非空写集。
  const bareRole = dispatchRoleBare(mission.agent_type);
  const scope = Array.isArray(mission.scope_paths) ? mission.scope_paths.filter(Boolean) : [];
  if (!DISPATCH_READONLY_ROLES.has(bareRole) && scope.length === 0) {
    throw new ToolError(
      "yolo 闸：worker 类 mission 的 scope_paths 为空——嵌套子代理按 scope_paths 审计写面，" +
        "必须先登记写集 scope_paths（越界可审计），或改走宿主 Agent 通道",
    );
  }
  // v1.6 W-p 剥离：headless busy 闸半区（result-dir index 判据+O10=a 超龄豁免）随 -p 通道
  // 迁 parked——result-dir 三件套对 nested 整体缺席（下方板语义闸不消费 result-dir index）。
  // v1.2 M5-1 nested busy 闸分叉（板语义，不消费 result-dir index）。在飞判定=
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
  // v1.6 W3a 回执编号化：CONTRACT 三行解析（下沉件 dispatchParseContract）——
  // worker/channel/token 自包 CONTRACT 解析（回执三元组）；缺三行在派发面即拒
  // （派发纪律工具面保证，§8.7——token 鉴权依赖三行，解析失败不产凭据）。
  const contract = dispatchParseContract(packText);
  if (!contract.channel || !contract.worker || !contract.token) {
    throw new ToolError(
      "包 CONTRACT 三行解析失败：需要 [channel] / [worker] / [token] 三行（启动器不另铸；" +
        "固定包如 glean-pack 声明「以派发 prompt 尾块为准」时须先在 mission 预铸 dispatch.token）",
    );
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
  // Sandbox cwd ≠ projectDir → the receipt pack_path must be absolute (DESIGN
  // §1.3: the worker Reads the pack via absolute path inside the worktree);
  // in-repo dispatch keeps the coordinator-facing display path. v1.6 W3a：该值
  // 供 DP-3 固定指针模板「先 Read 任务包 {pack_path}」机械填充（worker 自取包）。
  const receiptPackPath = cwd === projectDir ? displayPath(packFile) : path.resolve(packFile);

  // v1.2 M5-1 mode=nested 组装出口（主形态；v1.6 W3a 回执编号化后=编号出口）：
  // 不 spawn 进程、零组装文本——回执=编号三元组+pack_path，首条消息由主控按 DP-3
  // 固定指针模板（SKILL §3）机械填充回执字段交宿主 Agent 嵌套发出（run_in_background=true）；
  // worker 自取包（预设/开工协议：缺包/不可读→report(blocked)）。派发纪律仍靠工具面校验：
  //   ① CONTRACT 三行——上方 dispatchParseContract 强制（缺三行在此前抛错）；
  //   ② token 鉴权（p2pTokenGate 同语义落派发面）——包 CONTRACT token 必须 ≡
  //      mission.dispatch.token（context_pack 铸发、report/p2p 闸的 expected token）；
  //      无板 token 且 --strict-tokens → 拒（与 report 闸同向）；
  //   ③ scope_paths 预检——上方 yolo 闸（worker 类非空写集强制）。
  // 结构注记：if 包裹保持（NST-04b 接线静态锁判据 `if (dispatchMode === "nested")
  // {…ensureSentinelFamily();`——mode 校验收窄后恒真分支，结构即契约）。
  if (dispatchMode === "nested") {
    const boardToken =
      mission.dispatch && mission.dispatch.token ? String(mission.dispatch.token) : null;
    if (boardToken != null) {
      if (contract.token !== boardToken) {
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
    // 记账（mode=nested 先于宿主 Agent 存在即板上可见；spawned_by_session=W3 归因锚
    // 消费面〔v1.6 W3a 起谓词驻 server-board，下行 import〕；agent_id/task_id/session_id
    // 留 null——主控在场直收结果，哨兵 classify 要求 agent_id → nested 默认不盯，§5.2.4）。
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
    // v1.2 M9-1 触发面②（复活/自补员）出口接线：「无哨兵不派发」探活复用
    // ensureSentinelFamily（M9-1 既有实现，impl-plan M5-1 task 指定接同探活）。
    ensureSentinelFamily();
    return {
      ok: true,
      mode: "nested",
      mission_id: missionId,
      worker: contract.worker,
      channel: contract.channel,
      token: contract.token,
      pack_path: receiptPackPath,
      __nested: true, // wrapper 消费：nested 无进程可捕获，跳过 ≤8s 组合捕获（v1.6 W-p 起唯一形态）
    };
  }

  // v1.6 W-p 剥离：headless 分支随 -p 通道整体迁 parked/agent-orchestrator/——§12 选择类播种
  // 预检/拒绝回执（model_seed）、runner 接线+timeout_min、headless upsert（mode:"headless"）、
  // detached spawn、headless 秒级回执、wrapper ≤8s 组合捕获区与失败 hint 分叉全部退役；
  // v1.6 W3a：组装出口唯一形态=编号回执（上方分支），prompt/prompt_path/chars/persona
  // 四字段随组装退役删除（审计面=bg-gate 运行时 CONTRACT 头 presence 检测）。恢复指引
  // =parked/agent-orchestrator/README.md。
}

/** dispatch = root-lock held sync段（gates + board + 编号回执），锁内即终态回执。
 *  v1.6 W-p 剥离注记：原 wrapper ≤8s 组合捕获区随 headless 迁 parked——nested 出口
 *  无进程可捕获，锁内即终态。v1.1.1 W-B lock_hold_ms 量测面保留
 *  （grill#wake Q5：lock-hold-time 断言 <2000ms = 2s 锁预算黑盒量测面；
 *  断言腿 crv6-statemachine WB-SRV-g）。 */
function toolDispatch(args) {
  const lockT0 = Date.now();
  const prepared = withRootLock(() => toolDispatchInner(args));
  const lockHoldMs = Date.now() - lockT0;
  // v1.2 M5-1：nested 出口无进程可捕获——锁内即终态回执（v1.6 W-p 起唯一形态）。
  if (prepared.__nested) {
    delete prepared.__nested;
    return { ...prepared, lock_hold_ms: lockHoldMs };
  }
  return { ...prepared, lock_hold_ms: lockHoldMs };
}

export {
  toolDispatch,
};
