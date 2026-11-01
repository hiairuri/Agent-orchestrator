// agent-orchestrator orch server — stores：context mirror journal（只读）+ spool 邮箱文件层（机械拆分自 server.mjs L3240-3468）
import fs from "node:fs";
import path from "node:path";
import { root, safeSegment, hex, truncateStr } from "./server-core.mjs";
/* ------------------------------------------------------------------ */
/* context mirror store (v0.3 feature C: context/journal-*.jsonl)      */
/* read-only here: the journal files are written by hooks/journal.mjs  */
/* and the Stop side of hooks/stop-check.mjs                           */
/* ------------------------------------------------------------------ */

const contextDir = () => path.join(root, "context");

/** [{file, session_id, mtimeMs}] sorted by mtime descending. */
function listJournalFiles() {
  let entries = [];
  try {
    entries = fs.readdirSync(contextDir());
  } catch {
    return [];
  }
  const out = [];
  for (const name of entries) {
    if (!/^journal-.+\.jsonl$/.test(name)) continue;
    const file = path.join(contextDir(), name);
    try {
      const st = fs.statSync(file);
      if (!st.isFile()) continue;
      out.push({
        file,
        session_id: name.slice("journal-".length, name.length - ".jsonl".length),
        mtimeMs: st.mtimeMs,
      });
    } catch {
      /* best effort */
    }
  }
  out.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return out;
}

/** Parse a journal file line by line; bad lines are skipped. */
function readJournalRows(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const rows = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const obj = JSON.parse(line);
      if (obj && typeof obj === "object" && !Array.isArray(obj)) rows.push(obj);
    } catch {
      /* skip bad line */
    }
  }
  return rows;
}

/** Last n entries of a journal file as {kind, excerpt<=160 single-line}. */
function readJournalTail(file, n) {
  return readJournalRows(file)
    .slice(-n)
    .map((r) => ({
      kind: typeof r.kind === "string" ? r.kind : "unknown",
      excerpt: truncateStr(String(r.text ?? "").replace(/\s+/g, " ").trim(), 160),
    }));
}

/**
 * RECENT CONTEXT digest lines from the given journal files (most recent first):
 * at most maxLines entries and maxChars total; caller renders verbatim.
 */
function buildMirrorDigest({ files, maxLines, maxChars }) {
  const lines = [];
  let used = 0;
  for (const f of files) {
    for (const tail of readJournalTail(f.file, maxLines)) {
      if (lines.length >= maxLines) return lines;
      const line = `- [${tail.kind}] ${tail.excerpt}`;
      if (!line.trim() || line === `- [${tail.kind}]`) continue;
      if (lines.length && used + line.length + 1 > maxChars) return lines;
      lines.push(line);
      used += line.length + 1;
    }
  }
  return lines;
}

/* ------------------------------------------------------------------ */
/* spool                                                               */
/* ------------------------------------------------------------------ */

function missionSpoolDir(missionId) {
  return path.join(root, "spool", safeSegment(missionId, "mission_id"));
}
const unreadDirOf = (missionId) => path.join(missionSpoolDir(missionId), "unread");
const readDirOf = (missionId) => path.join(missionSpoolDir(missionId), "read");

function listSpoolMissions() {
  const spool = path.join(root, "spool");
  let entries = [];
  try {
    entries = fs.readdirSync(spool);
  } catch {
    return [];
  }
  return entries.filter((name) => {
    try {
      return fs.statSync(path.join(spool, name)).isDirectory();
    } catch {
      return false;
    }
  });
}

function listUnreadFiles(missionId) {
  const dir = unreadDirOf(missionId);
  let entries = [];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return [];
  }
  return entries
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => path.join(dir, f));
}

/**
 * v0.6 (V6-49): a malformed event file used to parse-fail to null forever,
 * so its unread entry stayed ".json" and countUnread never reached zero —
 * close paths reported a permanent fake "unread left" alarm (QQagent hit).
 * Quarantine: rename once to <file>.bad (drops out of the .json listing,
 * bytes preserved for forensics), then return null. Read IO errors (file
 * vanished mid-rename race) return null WITHOUT quarantining.
 */
function readEventFile(file) {
  let rawText;
  try {
    rawText = fs.readFileSync(file, "utf8");
  } catch {
    return null; // read race / already consumed — nothing to quarantine
  }
  let parsed = null;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    parsed = null; // malformed → quarantine below
  }
  if (!parsed || typeof parsed !== "object") {
    try {
      if (file.endsWith(".json")) fs.renameSync(file, file + ".bad");
    } catch {
      /* best effort: stays unread, retried next pass */
    }
    return null;
  }
  return parsed;
}

function countUnread(missionId) {
  return listUnreadFiles(missionId).length;
}

/** v1.1 W6 (QA P2-b): list-face wrapper — countUnread resolves the spool path
 * through safeSegment, so one legacy/hand-edited id ("bad/id", whitespace,
 * Windows reserved name, >128 chars) used to fail the whole board list. The
 * 1.0.0 list view was path-free and tolerant; keep it that way by treating an
 * unusable id as zero unread (spool counting is best-effort everywhere). */
function countUnreadSafe(missionId) {
  try {
    return countUnread(missionId);
  } catch {
    return 0;
  }
}

function eventAgeMs(payload) {
  const at = Date.parse(payload && payload.at ? String(payload.at) : "");
  if (Number.isFinite(at)) return Math.max(0, Date.now() - at);
  return 0;
}

/**
 * Consume one unread event via rename(unread -> read). If the destination name
 * is taken (Windows rename-onto-existing), retry with a "-1" suffix, then with
 * a random hex suffix.
 *
 * v0.3.1: a rename can report success while the source name is still visible
 * (cross-process metadata lag with concurrently open handles) — the move is
 * verified by re-checking the source afterwards; while it persists the same
 * destination is retried, and an event that cannot be moved verifiably is
 * reported via err.unresolved so the caller leaves it for the next read
 * instead of double-delivering it.
 */
function consumeEventFile(srcFile, missionId) {
  const dstDir = readDirOf(missionId);
  fs.mkdirSync(dstDir, { recursive: true });
  const base = path.basename(srcFile);
  const stem = base.replace(/\.json$/i, "");
  const candidates = [
    path.join(dstDir, base),
    path.join(dstDir, `${stem}-1.json`),
    path.join(dstDir, `${stem}-${hex(4)}.json`),
  ];
  let lastErr = null;
  for (const dst of candidates) {
    let moved = false;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        fs.renameSync(srcFile, dst);
        moved = true;
        if (!fs.existsSync(srcFile)) return dst; // verifiably moved
      } catch (err) {
        lastErr = err;
        moved = false;
        break; // destination likely taken → next candidate
      }
    }
    if (moved) {
      // "Successful" renames yet the source is still visible: do not claim it.
      const err = new Error(`consume unresolved (src still visible): ${srcFile}`);
      err.unresolved = true;
      lastErr = err;
      continue;
    }
  }
  throw lastErr;
}

export {
  contextDir,
  listJournalFiles,
  readJournalRows,
  readJournalTail,
  buildMirrorDigest,
  missionSpoolDir,
  unreadDirOf,
  readDirOf,
  listSpoolMissions,
  listUnreadFiles,
  readEventFile,
  countUnread,
  countUnreadSafe,
  consumeEventFile,
  eventAgeMs,
};
