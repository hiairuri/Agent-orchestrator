/**
 * bg-sentinel/echo.mjs —— 回声三通道（本地 echo.jsonl + 平台邮箱信封 + OS toast 兜底）。
 * 自 bg-sentinel.mjs 机械拆分（纯搬运 + import/export 接线，零行为变更）。
 */
import fs from "node:fs";
import path from "node:path";
import child_process from "node:child_process";
import { ECHO_MAX_LINES, PRUNE_AGE_MS } from "./core.mjs";
import { coordSessionId, signalsOf } from "./signals.mjs";

/* ================================================================== */
/* 回声（本地 + 平台邮箱 + OS toast 兜底）                                */
/* ================================================================== */

export function echoFile(rootDir) {
  return path.join(rootDir, "sentinel", "echo.jsonl");
}

/** 本地回声：退出路径追加一行；>256 行滚动截半；坏行跳过。 */
export function appendEcho(rootDir, claims, summary, extra) {
  const f = echoFile(rootDir);
  try {
    fs.mkdirSync(path.dirname(f), { recursive: true });
    const line =
      JSON.stringify({
        at: new Date().toISOString(),
        key: claims.map((c) => c.key).join(","),
        category: claims.map((c) => c.category).join(","),
        final: claims.some((c) => c.final),
        ...(extra && extra.toast_attempted ? { toast_attempted: true } : {}),
        summary_head: String(summary).replace(/\s+/g, " ").slice(0, 300),
      }) + "\n";
    let raw = "";
    try {
      raw = fs.readFileSync(f, "utf8");
    } catch {
      /* 首行 */
    }
    let lines = raw.split("\n").filter((x) => x.trim());
    lines.push(line.trim());
    if (lines.length > ECHO_MAX_LINES) lines = lines.slice(lines.length - Math.floor(ECHO_MAX_LINES / 2));
    fs.writeFileSync(f, lines.join("\n") + "\n");
  } catch {
    /* 回声绝不弄挂开枪路径 */
  }
}

export function pruneEcho(rootDir) {
  const f = echoFile(rootDir);
  try {
    const raw = fs.readFileSync(f, "utf8");
    const cutoff = Date.now() - PRUNE_AGE_MS;
    const kept = raw
      .split("\n")
      .filter((x) => x.trim())
      .filter((x) => {
        try {
          const t = Date.parse(String(JSON.parse(x).at));
          return Number.isFinite(t) ? t >= cutoff : true;
        } catch {
          return true; // 坏行留待滚动淘汰
        }
      });
    fs.writeFileSync(f, kept.join("\n") + (kept.length ? "\n" : ""));
  } catch {
    /* best effort */
  }
}

/**
 * 平台邮箱回声信封（六字段缺一不可）+ 写前自校验 + tmp+rename 原子落盘。
 * 平台 drain 对坏文件会阻塞整次消费（毒丸）——校验失败放弃外写（本地回声仍在）；
 * 任何 fs 失败静默——回声是保底通道，绝不允许它把开枪路径搞挂。
 */
export function buildEnvelope(claims, summary, coordId, slot) {
  const name = `orch-sentinel-${Date.now()}-${process.pid}`;
  return {
    version: 1, // number，必须严格 === 1
    messageId: name,
    fromSessionId: `orch-sentinel-slot${slot}`,
    toSessionId: coordId,
    content: String(summary).replace(/\s+/g, " ").slice(0, 500),
    createdAt: new Date().toISOString(),
  };
}

export function validateEnvelope(env) {
  if (!env || typeof env !== "object") return false;
  if (env.version !== 1 || typeof env.version !== "number") return false;
  for (const k of ["messageId", "fromSessionId", "toSessionId", "content", "createdAt"]) {
    if (typeof env[k] !== "string" || !env[k]) return false;
  }
  return true;
}

export function mailboxEcho(rootDir, claims, summary, cfg, slot) {
  try {
    const signals = signalsOf(cfg);
    const coordId = coordSessionId(rootDir, signals);
    if (!coordId) return false; // 无主会话 id → 只留本地回声
    const env = buildEnvelope(claims, summary, coordId, slot);
    const serialized = JSON.stringify(env, null, 2) + "\n";
    let roundtrip = null;
    try {
      roundtrip = JSON.parse(serialized);
    } catch {
      return false;
    }
    if (!validateEnvelope(roundtrip)) return false; // 自校验失败 → 弃写
    const dir = path.join(signals.mailboxRoot, coordId, "unread");
    fs.mkdirSync(dir, { recursive: true });
    const tmp = path.join(dir, `.${env.messageId}.${process.pid}.tmp`);
    fs.writeFileSync(tmp, serialized);
    fs.renameSync(tmp, path.join(dir, `${env.messageId}.json`));
    return true;
  } catch {
    return false; // 静默：保底通道故障不追责
  }
}

/** OS toast（第三通道，仅 abandoned final 枪）：powershell WinRT，fire-and-forget。 */
export function toastAbandon(cfg) {
  try {
    const signals = signalsOf(cfg);
    if (!signals.toastOnAbandon) return false;
    const ps = [
      '[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null',
      '$t=[Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)',
      '$x=$t.GetElementsByTagName("text")',
      '$x.Item(0).AppendChild($t.CreateTextNode("agent-orchestrator 哨兵")) | Out-Null',
      '$x.Item(1).AppendChild($t.CreateTextNode("有任务连续告警未获处置（abandoned），请接手任务板")) | Out-Null',
      '$n=[Windows.UI.Notifications.ToastNotification]::new($t)',
      '[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier("agent-orchestrator").Show($n)',
    ].join("; ");
    child_process
      .spawn("powershell.exe", ["-NoProfile", "-WindowStyle", "Hidden", "-Command", ps], {
        detached: true,
        stdio: "ignore",
      })
      .on("error", () => {})
      .unref();
    return true; // 尝试记录（可测）；弹窗成败不承责
  } catch {
    return false;
  }
}
