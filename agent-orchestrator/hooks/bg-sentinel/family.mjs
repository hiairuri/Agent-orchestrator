/**
 * bg-sentinel/family.mjs —— 家族槽位（认领/心跳/接管/让位）+ 寿命轮换选举（v2.1）
 * + 观测型隔离标记（V7-04 lite）。
 * 自 bg-sentinel.mjs 机械拆分（纯搬运 + import/export 接线，零行为变更）。
 */
import fs from "node:fs";
import path from "node:path";
import { HEARTBEAT_STALE_MS, pidAlive } from "./core.mjs";

/* ================================================================== */
/* 家族槽位                                                             */
/* ================================================================== */

export function slotDoc(startedAt, slot, tookOver, prev, state, rootDir) {
  return {
    pid: process.pid,
    slot,
    state: state === "standby" ? "standby" : state === "quarantined" ? "quarantined" : "active", // v2.1 待命制 + V7-04 隔离；旧版文件无此字段 = active
    root: rootDir ?? null, // V6-56 观测性：槽位自证解析根（root-id 契约下排障用）
    started_at: new Date(startedAt).toISOString(),
    heartbeatAt: new Date().toISOString(),
    ...(tookOver ? { took_over: true } : {}),
    ...(tookOver ? { prev: prev ?? null } : {}),
  };
}

export function slotFresh(doc, mtimeMs) {
  if (!doc || !Number.isFinite(doc.pid) || !pidAlive(doc.pid)) return false;
  const hb = Date.parse(String(doc.heartbeatAt ?? ""));
  let age = Number.isFinite(hb) ? Date.now() - hb : NaN; // B7
  if (!Number.isFinite(age)) {
    age = Number.isFinite(mtimeMs) ? Date.now() - mtimeMs : Number.POSITIVE_INFINITY;
  }
  return Math.max(0, age) <= HEARTBEAT_STALE_MS;
}

/** 启动清理：把心跳过期且 pid 已死的槽位文件删除（供认领；返回被删文档供 prev 记录）。 */
export function pruneStaleSlots(sentDir, familySize) {
  const stale = new Map();
  for (let k = 0; k < familySize; k++) {
    const f = path.join(sentDir, `instance-${k}.json`);
    let doc = null;
    let mtimeMs = NaN;
    try {
      doc = JSON.parse(fs.readFileSync(f, "utf8"));
    } catch {
      continue;
    }
    try {
      mtimeMs = fs.statSync(f).mtimeMs;
    } catch {
      continue;
    }
    if (!slotFresh(doc, mtimeMs) && !pidAlive(doc.pid)) {
      try {
        fs.unlinkSync(f);
        stale.set(k, doc);
      } catch {
        /* ENOENT/EPERM best effort */
      }
    }
  }
  return stale;
}

/** 认领最低空闲槽位；返回 {slot, tookOver, prev}；全满且全部新鲜 → slot=-1（静默让位）。 */
export function claimSlot(sentDir, familySize, startedAt, staleDocs, rootDir) {
  for (let k = 0; k < familySize; k++) {
    const f = path.join(sentDir, `instance-${k}.json`);
    let doc = null;
    try {
      doc = JSON.parse(fs.readFileSync(f, "utf8"));
    } catch {
      doc = null; // 不存在或坏文件 → 走 wx 创建
    }
    if (doc) {
      let mtimeMs = NaN;
      try {
        mtimeMs = fs.statSync(f).mtimeMs;
      } catch {
        /* gone between read and stat → wx below */
      }
      if (slotFresh(doc, mtimeMs)) continue; // 他人新鲜在岗 → 下一槽位
      // 接管（pid 死或心跳龄 >90s）：改写并记录 prev
      try {
        fs.writeFileSync(f, JSON.stringify(slotDoc(startedAt, k, true, doc, undefined, rootDir)) + "\n");
        return { slot: k, tookOver: true, prev: doc };
      } catch {
        continue;
      }
    }
    const prev = staleDocs && staleDocs.has(k) ? staleDocs.get(k) : null;
    const tookOver = Boolean(prev);
    try {
      fs.writeFileSync(f, JSON.stringify(slotDoc(startedAt, k, tookOver, prev, undefined, rootDir)) + "\n", { flag: "wx" });
      return { slot: k, tookOver, prev };
    } catch {
      /* EEXIST：竞争败者 → 下一槽位 */
    }
  }
  return { slot: -1, tookOver: false, prev: null };
}

export function touchSlot(sentDir, slot, startedAt, tookOver, prev, state, rootDir) {
  try {
    const f = path.join(sentDir, `instance-${slot}.json`);
    // v0.6 (V6-55)：touch 前重读槽位校验 pid 归属——被接管实例苏醒后让位（不覆盖
    // 他人心跳），退为无槽幽灵（firedEligible/claimShots 仲裁本就防双开枪，幽灵只
    // 损失观测在岗性）；后续 tick 持续让位。不改 slotDoc 结构，待命制零冲突。
    try {
      const cur = JSON.parse(fs.readFileSync(f, "utf8"));
      if (cur && Number.isFinite(cur.pid) && cur.pid !== process.pid) return;
    } catch {
      /* 缺失/坏文件 → 无法证明他人所有，照常 touch（心跳保鲜优先） */
    }
    // 心跳 touch 保留接管痕迹（可观测性，B3 同款）；state 反映当前待命/值守（v2.1）
    fs.writeFileSync(
      f,
      JSON.stringify(slotDoc(startedAt, slot, tookOver, prev, state, rootDir)) + "\n",
    );
  } catch {
    /* best effort */
  }
}

export function releaseSlot(sentDir, slot) {
  try {
    fs.unlinkSync(path.join(sentDir, `instance-${slot}.json`));
  } catch {
    /* ENOENT best effort */
  }
}

/* ================================================================== */
/* 家族轮换选举（v2.1：寿命 cap 单赢家，每寿命周期至多 1 条通知）           */
/* ================================================================== */

export function teardownFile(rootDir) {
  return path.join(rootDir, "sentinel", "family-teardown.json");
}

/**
 * 寿命到期时的单赢家选举：认领 <sentinel>/family-teardown.json（wx 原子创建）。
 * 返回 true = 本实例是本轮唯一赢家（可退出——退出即通知，赢家仅此一枪）；
 * 返回 false = 输家（见新鲜标记 / 竞争失败），调用方顺延自身寿命进入下一轮。
 * 仲裁：新鲜标记（age < freshMs）→ 输家；无标记 → 认领；陈旧/损坏标记 → 夺位
 * （复核后 unlink 再 wx）；并发竞争由 wx 串行化，3 轮尝试后仍败 → 本轮顺延，
 * 绝不出现双赢家双退出。旧版实例不识此标记照旧自退出（混跑兼容，非 fatal）。
 */
export function claimTeardown(rootDir, slot, freshMs) {
  const f = teardownFile(rootDir);
  const now = Date.now();
  const readAt = () => {
    try {
      const t = Date.parse(String(JSON.parse(fs.readFileSync(f, "utf8")).at ?? ""));
      return Number.isFinite(t) ? t : 0; // 坏 at 字段 → 视为最老（可夺位）
    } catch {
      return null; // 缺失或整文件损坏
    }
  };
  const write = () => {
    try {
      fs.writeFileSync(
        f,
        JSON.stringify({ at: new Date(now).toISOString(), pid: process.pid, slot }) + "\n",
        { flag: "wx" },
      );
      return true;
    } catch {
      return false; // EEXIST：他人先到（并发赢家或待夺位的旧标记）
    }
  };
  for (let i = 0; i < 3; i++) {
    const at = readAt();
    if (at !== null && now - at < freshMs) return false; // 新鲜标记 → 输家顺延
    if (write()) return true; // 无标记（或上轮已夺位删除）→ 赢家
    const at2 = readAt(); // EEXIST → 复核：并发赢家刚写入？
    if (at2 !== null && now - at2 < freshMs) return false;
    try {
      fs.unlinkSync(f); // 陈旧/损坏标记 → 夺位后重试
    } catch {
      /* gone：下轮 wx 直接认领 */
    }
  }
  return false; // 极端竞争：本轮放弃（顺延），下轮再选
}

/* ================================================================== */
/* 观测型隔离（V7-04 lite）：quarantine.json 标记 + 家族级告警抑制        */
/* ================================================================== */

export const Q_CLAIM = { key: "__quarantine__", category: "quarantine", final: false };

export function quarantineFile(rootDir) {
  return path.join(rootDir, "sentinel", "quarantine.json");
}

/** 读隔离标记；null = 无标记/损坏（损坏标记由认领方夺位重写，不在此处理）。 */
export function readQuarantine(rootDir) {
  try {
    const doc = JSON.parse(fs.readFileSync(quarantineFile(rootDir), "utf8"));
    if (!doc || typeof doc !== "object") return null;
    const at = Date.parse(String(doc.at ?? ""));
    return { doc, atMs: Number.isFinite(at) ? at : 0 };
  } catch {
    return null;
  }
}

/** 标记新鲜 = age < capWindowMs（与 fired 封顶窗同刻度）；新鲜期内全家族告警挂起。 */
export function quarantineFresh(rootDir, cfg) {
  const q = readQuarantine(rootDir);
  return q !== null && Date.now() - q.atMs < cfg.capWindowMs;
}

/**
 * 认领隔离标记（wx 原子创建；返回 true = 本实例是本 episode 唯一首告者）。
 * EEXIST 时：新鲜标记 → false（他人已隔离，静默加入——三实例恰一条告警的仲裁点）；
 * 陈旧/损坏标记 → unlink 夺位重写（true，超窗 episode 的合理再提醒）。
 */
export function claimQuarantine(rootDir, slot, reason, evidence, freshMs) {
  const write = () => {
    try {
      fs.mkdirSync(path.dirname(quarantineFile(rootDir)), { recursive: true });
      fs.writeFileSync(
        quarantineFile(rootDir),
        JSON.stringify({ at: new Date().toISOString(), pid: process.pid, slot, reason, evidence: evidence ?? null }) + "\n",
        { flag: "wx" },
      );
      return true;
    } catch {
      return false;
    }
  };
  if (write()) return true;
  const q = readQuarantine(rootDir);
  if (q && Date.now() - q.atMs < freshMs) return false;
  try {
    fs.unlinkSync(quarantineFile(rootDir));
  } catch {
    /* gone：下方 write 直接认领 */
  }
  return write();
}

/** 隔离聚合告警文案（既有通道一条：平台邮箱 + 本地回声；不退出、无 toast）。 */
export function buildQuarantineAlert(reason) {
  return (
    `[orch-sentinel] 观测异常隔离告警：${reason}。哨兵实例转 quarantined 低频值守` +
    `（不退出不杀进程不写 board；异常解除自动恢复 active/standby）。隔离期内全家族告警挂起` +
    `（新条件不触发 fired，超 cap_window 自动恢复），证据快照见 sentinel/quarantine.json。`
  );
}
