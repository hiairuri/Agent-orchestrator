// agent-orchestrator orch server — sentinel health 只读视图（机械拆分自 server.mjs L3470-3656）
import fs from "node:fs";
import path from "node:path";
import { root } from "./server-core.mjs";
import { boardFile, missionAck } from "./server-board.mjs";
/* ------------------------------------------------------------------ */
/* sentinel health（v0.4.1 只读视图；v0.7-A3 V7-06 三态聚合展示面）      */
/* ------------------------------------------------------------------ */

const SENTINEL_HEARTBEAT_STALE_MS = 90000; // twin of bg-sentinel / bg-gate B3 rule
// v0.7-A3 (V7-06): slotDoc state 枚举（bg-sentinel v2.1 待命制 + V7-04 隔离值守）。
// 旧版槽位文件无 state 字段 = active（与 bg-sentinel touchSlot 归一规则同规）。
const SENTINEL_ON_DUTY_STATES = ["active", "standby", "quarantined"];

function serverPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return Boolean(err && err.code === "EPERM");
  }
}

/** Read-only health view; ANY failure returns {available:false} (never throws).
 * v0.7-A3 (V7-06): 附三态 summary（在岗 active/待命 standby/隔离值守 quarantined、
 * 可补员=无任何存活实例、无哨兵=零实例）——standby 家族对主控全程可观测。 */
function sentinelHealth() {
  try {
    const dir = path.join(root, "sentinel");
    const out = { available: true, family_size: 3, instances: [], shots_24h: [], abandoned: [], echo_tail: [] };
    // family size preference comes from the published cfg (default 3)
    try {
      const cfg = JSON.parse(fs.readFileSync(path.join(root, "sentinel.cfg.json"), "utf8"));
      const n = Number(cfg && cfg.family_size);
      if (Number.isFinite(n)) out.family_size = Math.min(5, Math.max(1, Math.round(n)));
    } catch {
      /* keep default */
    }
    // instances: V7-06 定稿形状 {slot, pid_alive, state, hb_age_sec, took_over, root}
    //（在岗 on_duty = pid 活 ∧ 心跳新鲜；state ∈ {active,standby,quarantined} 全部归在岗
    // 语义——quarantined 仅挂起告警，心跳照旧，不降格为死亡）
    const now = Date.now();
    const names = fs.readdirSync(dir).filter((n) => /^instance-\d+\.json$/.test(n));
    for (const n of names) {
      try {
        const f = path.join(dir, n);
        const doc = JSON.parse(fs.readFileSync(f, "utf8"));
        const hb = Date.parse(String(doc.heartbeatAt ?? ""));
        let age = Number.isFinite(hb) ? now - hb : NaN;
        if (!Number.isFinite(age)) age = now - fs.statSync(f).mtimeMs;
        const pidAlive = serverPidAlive(Number(doc.pid));
        const state = SENTINEL_ON_DUTY_STATES.includes(doc.state) ? doc.state : "active";
        out.instances.push({
          slot: Number(doc.slot ?? n.match(/^instance-(\d+)\./)?.[1] ?? -1),
          pid: Number(doc.pid ?? 0),
          pid_alive: pidAlive,
          state,
          hb_age_sec: Math.max(0, Math.round(age / 1000)),
          took_over: Boolean(doc.took_over),
          root: typeof doc.root === "string" ? doc.root : null,
          started_at: doc.started_at ?? null,
          on_duty: pidAlive && Math.max(0, age) <= SENTINEL_HEARTBEAT_STALE_MS,
        });
      } catch {
        /* skip bad slot file */
      }
    }
    out.instances.sort((a, b) => a.slot - b.slot);
    // V7-06 家族级三态 summary：在岗 active／在岗待命 standby／隔离值守 quarantined
    //（三者同属在岗语义，quarantined 归在岗）；可补员=无任何存活实例；无哨兵=零实例。
    // 混编取最强在岗态 active > quarantined > standby；stale 明细由逐实例 pid_alive/on_duty 呈现。
    {
      const duty = out.instances.filter((i) => i.on_duty);
      if (out.instances.length === 0) {
        out.summary = { state: "none", on_duty: false, on_duty_n: 0, total: 0, text: "no sentinel (recommend raising one)" };
      } else if (duty.length === 0) {
        out.summary = { state: "reinforce", on_duty: false, on_duty_n: 0, total: out.instances.length, text: "slots stale (replenishable)" };
      } else {
        const famState = duty.some((i) => i.state === "active")
          ? "active"
          : duty.some((i) => i.state === "quarantined")
            ? "quarantined"
            : "standby";
        const text =
          famState === "active"
            ? "on duty (new dispatches in flight; graded-alert watch)"
            : famState === "quarantined"
              ? "quarantined duty (on duty: alerts suspended during the observation anomaly; low-frequency watch)"
              : "standby on duty (auto-takes-over new dispatches)";
        out.summary = { state: famState, on_duty: true, on_duty_n: duty.length, total: out.instances.length, text };
      }
    }
    // fired entries (24h window), newest first
    const cutoff = now - 24 * 3600 * 1000;
    const firedDir = path.join(dir, "fired");
    let entries = [];
    try {
      entries = fs
        .readdirSync(firedDir)
        .filter((n) => n.endsWith(".json"))
        .map((n) => {
          try {
            const doc = JSON.parse(fs.readFileSync(path.join(firedDir, n), "utf8"));
            return { doc, mtimeMs: fs.statSync(path.join(firedDir, n)).mtimeMs };
          } catch {
            return null;
          }
        })
        .filter(Boolean)
        .filter((e) => e.mtimeMs >= cutoff);
    } catch {
      /* no fired dir */
    }
    entries.sort((a, b) => b.mtimeMs - a.mtimeMs);
    out.shots_24h = entries.slice(0, 10).map((e) => ({
      key: e.doc.key ?? null,
      category: e.doc.category ?? null,
      at: e.doc.at ?? new Date(e.mtimeMs).toISOString(),
      final: e.doc.final === true,
    }));
    // abandoned: missions with a final (cap) shot whose state is STILL suspicious.
    // shots = total window shots for that mission (design §4.8 shows shots:3).
    let board = null;
    try {
      board = JSON.parse(fs.readFileSync(boardFile(), "utf8"));
    } catch {
      board = null;
    }
    const isSuspicious = (id) => {
      if (!board || !Array.isArray(board.missions)) return false;
      const m = board.missions.find((x) => x && x.id === id);
      if (!m) return false;
      return (
        ["done", "failed", "blocked", "question"].includes(m.status) &&
        missionAck(m) === null &&
        (m.dispatch && m.dispatch.mode) !== "workflow"
      );
    };
    const byMission = new Map();
    for (const e of entries) {
      const id = e.doc.mission_id ? String(e.doc.mission_id) : null;
      if (!id) continue;
      const cur = byMission.get(id) || {
        key: id,
        category: e.doc.category,
        shots: 0,
        last_at: null,
        hasFinal: false,
      };
      cur.shots += 1;
      if (e.doc.final === true) cur.hasFinal = true;
      const at = e.doc.at ?? new Date(e.mtimeMs).toISOString();
      if (!cur.last_at || at > cur.last_at) cur.last_at = at;
      byMission.set(id, cur);
    }
    out.abandoned = [...byMission.values()]
      .filter((a) => a.hasFinal && isSuspicious(a.key))
      .map((a) => {
        let title = "";
        try {
          const m = board.missions.find((x) => x && x.id === a.key);
          title = String((m && m.title) || "");
        } catch {
          /* keep empty */
        }
        return { key: a.key, category: a.category, shots: a.shots, last_at: a.last_at, mission_title: title };
      });
    // echo tail (≤3 newest summaries)
    try {
      const lines = fs
        .readFileSync(path.join(dir, "echo.jsonl"), "utf8")
        .split("\n")
        .filter((x) => x.trim());
      out.echo_tail = lines
        .slice(-3)
        .reverse()
        .map((x) => {
          try {
            const o = JSON.parse(x);
            return String(o.summary_head || "").slice(0, 160);
          } catch {
            return x.slice(0, 160);
          }
        });
    } catch {
      /* no echo file */
    }
    return out;
  } catch {
    return { available: false };
  }
}

export {
  SENTINEL_HEARTBEAT_STALE_MS,
  sentinelHealth,
};
