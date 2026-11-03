// agent-orchestrator orch server — dispatch 模型播种模块（provenance：v1.5 W2-A T7 裁 a 自 mcp/tool-dispatch.mjs
// 单文件〔1647 行，ece2e80 基〕机械拆分 :769-1044 逐字搬运：选型两源快速失败（dispatchPickSeedModel/
// dispatchListApikeyProviders 纯区）+拥塞戳域（F-C8 stamp face，root/atomicWriteFileSync 消费）。
// 消费方=mcp/tool-dispatch/dispatch-core.mjs（播种配置+回执分类面）。

import fs from "node:fs";
import path from "node:path";
import { root, atomicWriteFileSync } from "../server-core.mjs";

/** Pick the seed target model. `modelArg` = "providerId/modelId[@level]".
 *  v1.2.3 W2 播种两源快速失败（v1.2 M3-1 三段式的段③「首个 enabled api-key」猜测
 *  已删除——禁 api-key 自动回落，l-20261027-ad8a34 实证其落拥塞模型致整批全灭）：
 *  ① 显式 model 参数：api-key 型采信（levelExplicit 标记显式 @level）；account 族
 *  按 access.type 识别（非 account: 前缀）→ 显式拒绝 rejected.kind=account_not_seedable
 *  （reason 双写保持 model_arg_unusable 字面）；provider 不存在/其他未知 access
 *  类型 → unusable（reason=model_arg_unusable 字面保留、无 rejected 字段——非选择
 *  类，boot-then-die 现行为不变）。
 *  ② 会话真值 defaultModelSelection：provider enabled + api-key 才采信（O9=a：level
 *  原值直通不经 levelOf 重解析，fromDms 标记驱动 dispatchSeedModelConfig 跳过 dms
 *  覆写）；disabled/account/形态非法 → 快速失败 rejected.kind=dms_provider_disabled /
 *  dms_provider_account / dms_shape_invalid（reason 与 kind 同名直通）。
 *  两源皆缺 → selection_missing 快速失败（no_apikey_model 字面随段③删除退役）。
 *  返回形态：成功 {providerId, modelId, reasoningLevel, fromDms?, levelExplicit?}；
 *  选择类拒绝 {reason, reject:{kind, provider_id?, detail}}；显式负例 {unusable:true}。 */
function dispatchPickSeedModel(doc, modelArg) {
  const isAccountAccess = (t) => typeof t === "string" && t !== "api-key" && /account/i.test(t);
  const rules = doc && doc.config && doc.config.providerConfigRules && doc.config.providerConfigRules.providerRules;
  const modelRules =
    (doc && doc.config && doc.config.modelConfigRules && doc.config.modelConfigRules.providerModelRules) || [];
  const levelOf = (providerId, modelId, explicit) => {
    if (explicit) return explicit;
    const entry = modelRules.find((r) => r && r.providerId === providerId && r.modelId === modelId);
    const values =
      entry && entry.config && entry.config.optionSpecs && entry.config.optionSpecs.reasoningLevel &&
      Array.isArray(entry.config.optionSpecs.reasoningLevel.values)
        ? entry.config.optionSpecs.reasoningLevel.values
        : null;
    // gQi (bundle @596667) mirrors the TUI picker: values.at(-1). Unknown →
    // null: the seed then OMITS defaultModelSelection and the CLI's own
    // registry-fallback supplies a valid level (FA bisect: a personal model
    // rule WITHOUT optionSpecs resolves via builtin values, e.g. GLM-4.7-Flash
    // @ "disabled"; guessing a level the builtin values lack = not selectable).
    return values && values.length ? String(values[values.length - 1]) : null;
  };
  if (modelArg) {
    const m = /^(.+)\/([^/@]+)(?:@(.+))?$/.exec(String(modelArg).trim());
    if (!m) return { unusable: true };
    const rule = Array.isArray(rules) ? rules.find((r) => r && r.providerId === m[1]) : null;
    if (!rule || !rule.config || !rule.config.access) {
      // v1.3 W5 识别面腿（design §13.1① fold，O15=a）：account: 前缀盲区预判——
      // providerRules 只载 personal 面（account 族规则在 builtin、server 读取域外），
      // 规则不可见＋前缀在场 → 直接走选择类拒绝回执（§12 fork before spawn=mission
      // 留 drafted 可重派），不再 boot-then-die 静默死。两条保绿硬约束：
      // ①access.type 主识别不动——规则可见走原腿（api-key 采信／account access.type
      //   拒绝 reason=model_arg_unusable，DS-02 场景照旧）；
      // ②非前缀＋provider 缺失仍走本腿 unusable（reason=model_arg_unusable 字面
      //   verbatim，DS-08 场景不变，防前缀腿误拦）。
      if (/^account:/.test(m[1])) {
        return {
          reason: "account_not_seedable",
          reject: {
            kind: "account_not_seedable",
            provider_id: m[1],
            detail:
              "model 前缀 account: 指向 account 族 provider " + m[1] +
              "，其规则在 server 读取域（personal provider_config.json）不可见——" +
              "standalone -p 禁种（禁种裁定 2026-10-30）",
          },
        };
      }
      return { unusable: true };
    }
    if (rule.config.access.type === "api-key") {
      return {
        providerId: m[1],
        modelId: m[2],
        reasoningLevel: levelOf(m[1], m[2], m[3] || null),
        levelExplicit: Boolean(m[3]),
      };
    }
    if (isAccountAccess(rule.config.access.type)) {
      // v1.2.3 W2: explicit user intent at an unseedable provider — refuse
      // loudly instead of the old silent null (硬约束② account 禁种 -p).
      return {
        reason: "model_arg_unusable", // dual-write: FA-3 predicate stays verbatim
        reject: {
          kind: "account_not_seedable",
          provider_id: m[1],
          detail:
            "provider " + m[1] + " 的 access.type=" + String(rule.config.access.type) +
            "（account 族）在 standalone -p 下无桌面 entitlement、永不可用（禁种裁定 2026-10-30）",
        },
      };
    }
    return { unusable: true };
  }
  // v1.2.3 W2 段②（v1.2 M3-1 语义延续，回落腿已删）：会话真值 dms 是 model= 缺席时
  // 的唯一采信来源。provider 层校验（enabled + api-key 类型）不满足 → 快速失败，
  // reason 区分 dms_provider_disabled / dms_provider_account / dms_shape_invalid，
  // 不再穿透任何猜测段。model 层从宽（不查 modelRules enabled——宿主真值不重裁）。
  // level 取 dms 原值（O9=a）：不经 levelOf 重解析，缺失时 null（种子覆写跳过后该
  // 值不进种子文件，只做回执元数据）。
  if (!Array.isArray(rules)) {
    return {
      reason: "selection_missing",
      reject: { kind: "selection_missing", detail: "providerRules 缺失或非数组，无任何可采信选型来源" },
    };
  }
  const sel = doc.config.defaultModelSelection;
  if (sel != null) {
    if (typeof sel !== "object" || !sel.providerId || !sel.modelId) {
      return {
        reason: "dms_shape_invalid",
        reject: {
          kind: "dms_shape_invalid",
          provider_id: typeof sel === "object" && sel.providerId != null ? String(sel.providerId) : undefined,
          detail: "会话 defaultModelSelection 形态非法（缺 providerId/modelId 或非对象）",
        },
      };
    }
    const selRule = rules.find((r) => r && r.providerId === sel.providerId);
    if (!selRule || !selRule.config || !selRule.config.access) {
      return {
        reason: "dms_shape_invalid",
        reject: {
          kind: "dms_shape_invalid",
          provider_id: String(sel.providerId),
          detail: "defaultModelSelection 指向的 provider " + String(sel.providerId) + " 在 providerRules 中缺失或缺 access 形态",
        },
      };
    }
    if (selRule.enabled === false) {
      return {
        reason: "dms_provider_disabled",
        reject: {
          kind: "dms_provider_disabled",
          provider_id: String(sel.providerId),
          detail: "defaultModelSelection 指向的 provider " + String(sel.providerId) + " 已禁用（enabled=false）",
        },
      };
    }
    if (isAccountAccess(selRule.config.access.type)) {
      return {
        reason: "dms_provider_account",
        reject: {
          kind: "dms_provider_account",
          provider_id: String(sel.providerId),
          detail:
            "defaultModelSelection 指向 account 族 provider " + String(sel.providerId) +
            "（access.type=" + String(selRule.config.access.type) + "）——standalone -p 禁种",
        },
      };
    }
    if (selRule.config.access.type === "api-key") {
      return {
        providerId: String(sel.providerId),
        modelId: String(sel.modelId),
        reasoningLevel:
          sel.options && sel.options.reasoningLevel != null ? String(sel.options.reasoningLevel) : null,
        fromDms: true,
      };
    }
    return {
      reason: "dms_shape_invalid",
      reject: {
        kind: "dms_shape_invalid",
        provider_id: String(sel.providerId),
        detail: "defaultModelSelection 指向的 provider access.type=" + String(selRule.config.access.type) + " 非 api-key 且非 account 族",
      },
    };
  }
  return {
    reason: "selection_missing",
    reject: {
      kind: "selection_missing",
      detail: "无显式 model= 且会话 defaultModelSelection 缺席——不再回落「首个 enabled api-key」（禁自动回落）",
    },
  };
}

/** OPEN-1=B (v1.2.3 W2): enumerate enabled api-key providers with their first
 *  usable model, capped at `cap` entries — the receipt listing that makes the
 *  selection-class rejection actionable (informational only; seeding itself
 *  never falls back to these). Same provider/model expression the deleted
 *  stage-③ guess used, repurposed as listing source. */
function dispatchListApikeyProviders(doc, cap = 3) {
  const rules = doc && doc.config && doc.config.providerConfigRules && doc.config.providerConfigRules.providerRules;
  if (!Array.isArray(rules)) return [];
  const modelRules =
    (doc.config.modelConfigRules && doc.config.modelConfigRules.providerModelRules) || [];
  const out = [];
  for (const rule of rules) {
    if (!rule || rule.enabled === false) continue;
    if (!rule.config || !rule.config.access || rule.config.access.type !== "api-key") continue;
    const providerId = String(rule.providerId || "");
    if (!providerId) continue;
    const enabledModel = modelRules.find(
      (r) => r && r.providerId === providerId && r.modelId && r.config && r.config.enabled === true,
    );
    const listed =
      (Array.isArray(rule.config.modelOrder) && rule.config.modelOrder[0]) ||
      (Array.isArray(rule.config.personalModelIds) && rule.config.personalModelIds[0]) ||
      null;
    const modelId = (enabledModel && enabledModel.modelId) || listed || null;
    out.push(modelId ? providerId + "/" + String(modelId) : providerId);
    if (out.length >= cap) break;
  }
  return out;
}

/* ---------------- v1.3 W5 F-C8: congestion stamp face ----------------
 * 拥塞戳 `<root>/sentinel/dispatch-congestion.json`（card-sentinel.md 契约卡①
 * sentinel/ 目录族 E1 登记节）：{ "providerId/modelId": untilMs }。写方=dispatch
 * 失败回执分类面（modelCongested 命中→给本次播种对写戳，toolDispatch failed 分支）；
 * 读方=dispatchSeedModelConfig 跳选面。TTL 默认 30min（ORCH_DISPATCH_CONGESTION_TTL_MIN）；
 * kill switch=ORCH_DISPATCH_CONGESTION_OFF（真值=写戳+跳选双面全域停用，零行为差）。
 * **server 恒不创建 sentinel/ 目录**（card-sentinel.md §0 既有不变量、l0 V13
 * available 信号语义）：目录缺席=写戳静默跳过（生产面 bg-sentinel 启动 mkdir +
 * dispatch 派发前 ensureSentinelFamily 保证目录在场；测试面显式预建）。 */
function dispatchCongestionStampPath() {
  return path.join(root, "sentinel", "dispatch-congestion.json");
}

/** Kill switch: ORCH_DISPATCH_CONGESTION_OFF truthy（""/"0"/"false"=未启用）。 */
function dispatchCongestionOff() {
  const v = String(process.env.ORCH_DISPATCH_CONGESTION_OFF ?? "").trim();
  return v !== "" && v !== "0" && v !== "false";
}

/** TTL minutes（junk/非正数回落默认 30；上限 24h）。 */
function dispatchCongestionTtlMin() {
  const raw = Number(process.env.ORCH_DISPATCH_CONGESTION_TTL_MIN);
  if (Number.isFinite(raw) && raw > 0) return Math.min(Math.floor(raw), 24 * 60);
  return 30;
}

/** Live stamps only：过期条目读时懒清除（TTL 过期即删，best-effort 重写）；任何读
 *  失败（缺席/坏 JSON）→ {} =无在戳对（静默降级，跳选面零行为差）。 */
function dispatchCongestionRead() {
  try {
    const doc = JSON.parse(fs.readFileSync(dispatchCongestionStampPath(), "utf8"));
    if (!doc || typeof doc !== "object" || Array.isArray(doc)) return {};
    const now = Date.now();
    const out = {};
    for (const [k, v] of Object.entries(doc)) {
      const until = Number(v);
      if (Number.isFinite(until) && until > now) out[k] = until;
    }
    if (Object.keys(out).length !== Object.keys(doc).length) {
      try {
        atomicWriteFileSync(dispatchCongestionStampPath(), JSON.stringify(out, null, 2) + "\n");
      } catch {
        /* prune is best effort */
      }
    }
    return out;
  } catch {
    return {};
  }
}

/** 在戳判定：untilMs 存活（> now）即在戳（过期=不在戳）。 */
function dispatchCongestionStamped(stamp, pair) {
  const until = Number(stamp && stamp[pair]);
  return Number.isFinite(until) && until > Date.now();
}

/** Writer（分类面专用；best effort 绝不抛）：sentinel/ 目录缺席 → 返 false 跳过。 */
function dispatchCongestionStampPair(pair, ttlMin) {
  try {
    if (!fs.existsSync(path.join(root, "sentinel"))) return false;
    const stamp = dispatchCongestionRead();
    stamp[pair] = Date.now() + Math.max(1, Math.floor(ttlMin)) * 60000;
    atomicWriteFileSync(dispatchCongestionStampPath(), JSON.stringify(stamp, null, 2) + "\n");
    return true;
  } catch {
    return false;
  }
}

/** Build the seed copy under <root>/context/dispatch-model-seed/. The
 *  ORIGINAL personal config is never written (the CLI child gets the copy via
 *  ZCODE_PERSONAL_PROVIDER_CONFIG_FILE override in the runner) — the copy is
 *  the backup semantics the pack asks for, one mission-stamped file per
 *  dispatch (a re-dispatch overwrites its own mission's copy atomically). */

export {
  dispatchPickSeedModel,
  dispatchListApikeyProviders,
  dispatchCongestionStampPath,
  dispatchCongestionOff,
  dispatchCongestionTtlMin,
  dispatchCongestionRead,
  dispatchCongestionStamped,
  dispatchCongestionStampPair,
};
