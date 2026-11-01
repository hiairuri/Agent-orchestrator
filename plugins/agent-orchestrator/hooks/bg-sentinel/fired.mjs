/**
 * bg-sentinel/fired.mjs —— fired 协议（开枪仲裁 + 封顶放弃 + 24h 物理清理）。
 * 自 bg-sentinel.mjs 机械拆分（纯搬运 + import/export 接线，零行为变更）。
 */
import fs from "node:fs";
import path from "node:path";
import { PRUNE_AGE_MS } from "./core.mjs";
import { quarantineFresh } from "./family.mjs";
import { buildSummary } from "./classify.mjs";

/* ================================================================== */
/* fired 协议（开枪仲裁 + 封顶放弃）                                     */
/* ================================================================== */

export function firedDir(rootDir) {
  return path.join(rootDir, "sentinel", "fired");
}

export function firedEntries(rootDir, key, category) {
  const dir = firedDir(rootDir);
  let names = [];
  try {
    names = fs.readdirSync(dir).filter((n) => n.endsWith(".json"));
  } catch {
    return [];
  }
  const prefix = `${key}--${category}--`;
  const out = [];
  for (const n of names) {
    if (!n.startsWith(prefix)) continue;
    try {
      const doc = JSON.parse(fs.readFileSync(path.join(dir, n), "utf8"));
      const at = Date.parse(String((doc && doc.at) ?? ""));
      out.push({ file: n, doc, atMs: Number.isFinite(at) ? at : 0 });
    } catch {
      /* 坏条目跳过 */
    }
  }
  out.sort((a, b) => b.atMs - a.atMs); // 新 → 旧
  return out;
}

/** 仲裁：隔离标记新鲜期内 → false（V7-04 家族级告警抑制：聚合告警已由首告者发出）；
 *  Δ 内他人已开枪 → false；cap 窗口内满额 → false；否则 true。 */
export function firedEligible(rootDir, cond, cfg) {
  if (quarantineFresh(rootDir, cfg)) return false; // V7-04：隔离期告警挂起（超 cap_window 自动恢复）
  const entries = firedEntries(rootDir, cond.key, cond.category);
  const now = Date.now();
  if (entries.length && now - entries[0].atMs < cfg.refireGapMs) return false;
  const inWindow = entries.filter((e) => now - e.atMs < cfg.capWindowMs).length;
  if (inWindow >= condCap(cond, cfg)) return false;
  return true;
}

export function condCap(cond, cfg) {
  return cond.cap || cfg.cap;
}

/**
 * wx 认领一枪；返回认领成功的条目数组（失败者剔除）。写前数一遍现存条目，
 * 本次是第 cap 枪 → 条目带 final:true（放弃标记，不再另写文件）。
 */
export function claimShots(rootDir, due, cfg, slot) {
  const dir = firedDir(rootDir);
  const claimed = [];
  for (const c of due) {
    const entries = firedEntries(rootDir, c.key, c.category);
    const now = Date.now();
    if (entries.length && now - entries[0].atMs < cfg.refireGapMs) continue;
    const inWindow = entries.filter((e) => now - e.atMs < cfg.capWindowMs).length;
    const cap = condCap(c, cfg);
    if (inWindow >= cap) continue;
    const isFinal = inWindow + 1 >= cap;
    const doc = {
      key: c.key,
      category: c.category,
      ...(c.key === "__board__" ? {} : { mission_id: c.key }),
      at: new Date(now).toISOString(),
      by_pid: process.pid,
      slot,
      final: isFinal,
      summary_head: buildSummary([c], cfg).replace(/\s+/g, " ").slice(0, 200),
    };
    // v0.6 (V6-54)：文件名去 pid——同 key+category+同毫秒的双实例写同名文件，
    // wx 恢复「恰一成功」互斥（旧名带 pid 各写各名，读-写间隙留下双开枪 TOCTOU 窗）。
    const name = `${c.key}--${c.category}--${now}.json`;
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, name), JSON.stringify(doc) + "\n", { flag: "wx" });
      claimed.push({ ...c, final: isFinal });
    } catch {
      /* EEXIST：双实例同 tick 竞争，恰一成功；败者本轮放弃 */
    }
  }
  return claimed;
}

/** fired 条目唯一清理条款：>24h 由任意实例启动/每 30 分钟 unlink（catch ENOENT）。 */
export function pruneFired(rootDir) {
  const dir = firedDir(rootDir);
  let names = [];
  try {
    names = fs.readdirSync(dir).filter((n) => n.endsWith(".json"));
  } catch {
    return;
  }
  const now = Date.now();
  for (const n of names) {
    try {
      const f = path.join(dir, n);
      const st = fs.statSync(f);
      if (now - st.mtimeMs > PRUNE_AGE_MS) fs.unlinkSync(f);
    } catch {
      /* best effort */
    }
  }
}
