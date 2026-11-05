/**
 * bg-sentinel/wake-kick.mjs —— v1.1.1 W-B 哨兵 drain（完成即唤队列滞留消费）。
 * 自 bg-sentinel.mjs 机械拆分（纯搬运 + import/export 接线，零行为变更）。
 */
import fs from "node:fs";
import path from "node:path";
import child_process from "node:child_process";

/* ================================================================== */
/* v1.1.1 W-B 哨兵 drain（完成即唤队列滞留消费；grill#wake Q5：滞留 120s=2 tick） */
/* ================================================================== */

/* kick 失败遗留的队列事件由哨兵补一脚：spawn node hooks/wake-kick.mjs --root <root>
 * （注入判定/锚活性双闸/b2 禁用/认领串行化全在 kick 内——本侧零注入零网络，spawn 为
 * 本地子进程，「纯本地零网络」红线不破；kick 自带 120s 自杀护栏）。门口：队列空 /
 * 认领持有中（kick 在跑或生产者毫秒窗，claim.json 可解析且新鲜 <staleMs）→ 静默；
 * 陈旧/损坏认领=不持有（kick 侧超龄回收，WB-SRV-e 残留识别语义的消费面）。
 * 家族级 spawn 节流：sentinel/wake-kick-last-spawn mtime ≥ staleMs 才再 spawn
 * （3 实例错峰下家族 ≤1 次/staleMs，锚死重试风暴面收口；标记写败不阻 spawn）。 */
export function wakeQueueDir(rootDir) {
  return path.join(rootDir, "context", "wake-queue");
}

export function wakeQueueScan(rootDir, staleMs, nowMs) {
  const out = { total: 0, stranded: 0, claimHeld: false };
  const dir = wakeQueueDir(rootDir);
  let names = [];
  try {
    names = fs.readdirSync(dir).filter((n) => n.endsWith(".json") && n !== "claim.json");
  } catch {
    return out; // 队列目录缺失=空 → 静默
  }
  out.total = names.length;
  for (const n of names) {
    try {
      if (nowMs - fs.statSync(path.join(dir, n)).mtimeMs >= staleMs) out.stranded += 1;
    } catch {
      /* gone between read and stat */
    }
  }
  try {
    const doc = JSON.parse(fs.readFileSync(path.join(dir, "claim.json"), "utf8"));
    const at = Date.parse(String((doc && doc.acquired_at) ?? ""));
    out.claimHeld = !Number.isFinite(at) || nowMs - at < staleMs; // 损坏/陈旧=不持有（kick 回收）；可解析且新鲜=持有中
  } catch {
    out.claimHeld = false; // 缺失=不持有
  }
  return out;
}

export function spawnWakeKick(rootDir, projectDir, staleMs) {
  try {
    const marker = path.join(rootDir, "sentinel", "wake-kick-last-spawn");
    try {
      if (Date.now() - fs.statSync(marker).mtimeMs < staleMs) return false; // 家族级节流窗内
    } catch {
      /* 无标记=可 spawn */
    }
    try {
      fs.mkdirSync(path.dirname(marker), { recursive: true });
      fs.writeFileSync(marker, JSON.stringify({ at: new Date().toISOString() }) + "\n");
    } catch {
      /* 节流标记失败不阻 spawn（最坏=多一脚，kick 认领串行化兜底） */
    }
    const kickPath = path.join(path.dirname(process.argv[1] || ""), "wake-kick.mjs");
    const kid = child_process.spawn(process.execPath, [kickPath, "--root", rootDir], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
      cwd: projectDir,
    });
    kid.on("error", () => {}); // spawn 失败静默：事件留队，下 tick 再试（C1 板面告警回落既有行为）
    kid.unref();
    return true;
  } catch {
    return false;
  }
}
