// agent-orchestrator orch server — boot：memory root/项目注册表/journal GC/哨兵 cfg 桥/启动参数（机械拆分自 server.mjs L725-1115；顶层副作用保持原序）
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  root, rootId, projectDir, isTempRoot, parseArgValue, atomicWriteFileSync,
  log, hex, nowIso, SERVER_VERSION, ROOT_LOCK_STALE_MS, ROOT_LOCK_TIMEOUT_MS,
  sleepMs, pidAlive,
} from "./server-core.mjs";
/* ------------------------------------------------------------------ */
/* v0.8 (DESIGN §6.6/§8): two-tier memory — the global (cross-project) */
/* memory root. Default <~/.zcode>/orchestrator-memory; --memory-root  */
/* overrides (suite injection channel, §8 server-params row). Temp     */
/* roots (test harness) redirect the DEFAULT inside the temp root so   */
/* suite runs never touch the real home — same carve-out family as the */
/* root.txt bridge above ("test root must not stick"); an explicit     */
/* --memory-root always wins over both.                                */
/* ------------------------------------------------------------------ */

function resolveMemoryRoot() {
  const raw = parseArgValue(process.argv.slice(2), "--memory-root");
  const p = raw === undefined ? "" : String(raw).trim();
  if (!p || p.startsWith("${")) {
    return isTempRoot
      ? path.join(root, "orchestrator-memory")
      : path.join(os.homedir(), ".zcode", "orchestrator-memory");
  }
  return path.resolve(projectDir, p);
}
const memoryRoot = resolveMemoryRoot();

/** §4.1: the coordinator memory view lives at <存储根>/ORCH.md. */
const ORCH_MD_FILE = () => path.join(root, "ORCH.md");
/** v0.8 (§3.5/§6.6): the global lessons library — same row schema as the
 * project library; scope="global" is implied by the library, not stored
 * on demand. W2 wires the read side only (promotion is §6.7 / W5). */
const globalLessonsFile = () => path.join(memoryRoot, "memory", "lessons.jsonl");

/* §6.6 project registry — on every start upsert {root_id, project_path,
 * first_seen, last_seen, server_version, library_path} into
 * <memoryRoot>/projects.jsonl
 * under a mkdir lock in the memory root (.registry.lock, rootLockStale
 * pattern). The registry is NOT an event layer: re-sighting updates the
 * row in place (first_seen preserved, one line per root_id, never a
 * duplicate append); keying on the stable 16-hex root_id keeps rows
 * stable across project-path moves. library_path (v0.9 C7) records the
 * project lessons.jsonl this server instance actually resolved, so the
 * §6.7 sibling scan can find custom --root projects (the default-layout
 * mapping alone cannot; see promoteGlobalStandard). Registry writes are
 * best-effort: a busy/unwritable memory root logs and moves on — startup
 * never fails because of the registry. */
const REGISTRY_LOCK_STALE_MS = ROOT_LOCK_STALE_MS;

function registryLockDir() {
  return path.join(memoryRoot, ".registry.lock");
}

/** Same staleness contract as rootLockStale: holder pid dead, heartbeat
 * older than the stale window, or a docless dir older than the window. */
function registryLockStale(dir) {
  let owner = null;
  try {
    owner = JSON.parse(fs.readFileSync(path.join(dir, "owner.json"), "utf8"));
  } catch {
    try {
      return Date.now() - fs.statSync(dir).mtimeMs > REGISTRY_LOCK_STALE_MS;
    } catch {
      return true; // dir vanished between mkdir and here: retry as free
    }
  }
  if (!owner || !Number.isFinite(owner.pid) || !pidAlive(owner.pid)) return true;
  const hb = Date.parse(String(owner.heartbeatAt ?? ""));
  let ageMs = Number.isFinite(hb) ? Date.now() - hb : NaN;
  if (!Number.isFinite(ageMs)) {
    try {
      ageMs = Date.now() - fs.statSync(path.join(dir, "owner.json")).mtimeMs;
    } catch {
      return true;
    }
  }
  return Math.max(0, ageMs) > REGISTRY_LOCK_STALE_MS;
}

/** Run fn() under the registry mkdir lock; null when the lock stays busy
 * for the whole wait budget (best-effort callers treat that as skip).
 *
 * v0.8 W3 two-lock clarification (§6.4, deadlock-freedom): this registry
 * lock is a SHORT critical section — server-internal, held only across one
 * projects.jsonl upsert, abandoned after the ≤2s wait budget (best-effort).
 * The glean lock (<memoryRoot>/glean-lock.json) is a LONG-held advisory
 * lock owned by the orch-gleaner agent for its whole run (absolute expiry
 * 1.5h, §9.3). The two never nest, so they cannot deadlock: the server only
 * READS the glean lock (gleanLockInfo — a non-blocking judgment, see its
 * docblock) and the gleaner never takes this lock or the project root lock
 * (its lessons writes go through the lessons MCP tool, which takes the
 * PROJECT root lock; projects.jsonl is read-only for the gleaner, §6.2
 * OWNERSHIP). Disjoint files, disjoint takers, no lock ordering cycle. */
function withRegistryLock(fn) {
  const dir = registryLockDir();
  const deadline = Date.now() + ROOT_LOCK_TIMEOUT_MS;
  let backoff = 50;
  for (;;) {
    try {
      fs.mkdirSync(dir);
    } catch (err) {
      if (!err || err.code !== "EEXIST") throw err;
      if (!registryLockStale(dir)) {
        if (Date.now() >= deadline) return null;
        sleepMs(backoff + Math.floor(Math.random() * 50));
        backoff = Math.min(200, backoff + 50);
        continue;
      }
      // stale takeover via rename — only one contender can win it (V6-33
      // takeover pattern); the loser re-enters the loop as a plain racer.
      const trash = `${dir}.stale.${process.pid}.${hex(4)}`;
      try {
        fs.renameSync(dir, trash);
      } catch {
        continue; // someone else took it first
      }
      try {
        fs.rmSync(trash, { recursive: true, force: true });
      } catch {
        /* best effort */
      }
      continue;
    }
    // V6-33 pattern: never claim a lock we cannot describe — an owner-doc
    // write failure undoes THIS mkdir before retrying/giving up.
    try {
      fs.writeFileSync(
        path.join(dir, "owner.json"),
        JSON.stringify({ holder: `pid:${process.pid}`, pid: process.pid, heartbeatAt: nowIso() }) + "\n",
        { flag: "wx" },
      );
    } catch {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        /* best effort */
      }
      if (Date.now() >= deadline) return null;
      sleepMs(20);
      continue;
    }
    try {
      return fn();
    } finally {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        /* best effort */
      }
    }
  }
}

/** One registry row per root_id; re-sighting updates last_seen in place. */
function upsertProjectRegistry() {
  const file = path.join(memoryRoot, "projects.jsonl");
  let rows = [];
  try {
    rows = fs
      .readFileSync(file, "utf8")
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => {
        try {
          const o = JSON.parse(l);
          return o && typeof o === "object" && !Array.isArray(o) ? o : null;
        } catch {
          return null; // skip bad line (partial writes are not fatal)
        }
      })
      .filter(Boolean);
  } catch {
    /* first sighting: start a fresh registry */
  }
  const at = nowIso();
  const row = {
    root_id: rootId,
    project_path: projectDir,
    first_seen: at,
    last_seen: at,
    server_version: SERVER_VERSION,
    // v0.9 (C7): the project library this instance actually resolved. Inlined
    // (not via lessonsFile) because this upsert runs at module-load time,
    // before the lessons-store const declarations further down are evaluated.
    library_path: path.join(root, "memory", "lessons.jsonl"),
  };
  const idx = rows.findIndex((r) => r && r.root_id === rootId);
  if (idx >= 0) {
    row.first_seen = rows[idx].first_seen || at; // first sighting preserved
    rows[idx] = row; // in-place update: the registry is not an event layer
  } else {
    rows.push(row);
  }
  fs.mkdirSync(memoryRoot, { recursive: true });
  atomicWriteFileSync(file, rows.map((r) => JSON.stringify(r)).join("\n") + "\n", memoryRoot);
  return row;
}

try {
  withRegistryLock(upsertProjectRegistry);
} catch (err) {
  log("project registry upsert failed (non-fatal):", (err && err.message) || String(err));
}

/* ------------------------------------------------------------------ */
/* v0.6 (V6-51): startup GC for the v0.3 context mirror journals        */
/* ------------------------------------------------------------------ */

// Aligned with the sentinel's 30-day PRUNE horizon (DESIGN §2.7). Journals are
// bounded per session (rotate keeps one .old) but nothing ever pruned ACROSS
// sessions — long-lived roots grew context/ without bound. Deletion granularity
// is the whole file; the server side was chosen so cluster B's hook files stay
// untouched.
const JOURNAL_GC_AGE_MS = 30 * 24 * 60 * 60 * 1000;

function gcContextJournals() {
  const dir = path.join(root, "context");
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return 0; // no context dir → zero side effects
  }
  let removed = 0;
  const now = Date.now();
  for (const name of names) {
    if (!/^journal-.+\.jsonl(\.old)?$/.test(name)) continue;
    const f = path.join(dir, name);
    try {
      const st = fs.statSync(f);
      if (now - st.mtimeMs > JOURNAL_GC_AGE_MS) {
        fs.unlinkSync(f);
        removed += 1;
      }
    } catch {
      /* best effort: locked / vanished mid-scan → keep for the next start */
    }
  }
  return removed;
}
gcContextJournals(); // once at startup

/* ------------------------------------------------------------------ */
/* sentinel config bridge (v0.3 feature B)                             */
/* ------------------------------------------------------------------ */

/** Numeric argv option: empty / "${" template / invalid -> default, clamped. */
function numArg(argv, flag, def, min, max) {
  const raw = parseArgValue(argv, flag);
  const s = raw === undefined ? "" : String(raw).trim();
  if (s && !s.startsWith("${")) {
    const n = Number(s);
    if (Number.isFinite(n)) return Math.min(max, Math.max(min, n));
  }
  return def;
}

/**
 * v0.7 (V7-05) optional variant: ONLY an explicitly passed valid number returns
 * (clamped, same clamp as numArg); absent / empty / "${" template / invalid all
 * return null so the caller can skip the write entirely. Serves the sentinel
 * bridge keys — an unconditional default would shadow the sentinel's own
 * bridge chain (see writeSentinelCfg). Existing numArg is untouched.
 */
function numArgOpt(argv, flag, min, max) {
  const raw = parseArgValue(argv, flag);
  const s = raw === undefined ? "" : String(raw).trim();
  if (!s || s.startsWith("${")) return null;
  const n = Number(s);
  if (!Number.isFinite(n)) return null;
  return Math.min(max, Math.max(min, n));
}

/**
 * v0.3: the server never spawns the sentinel; it only publishes the user's
 * wake-sentinel settings to <root>/sentinel.cfg.json so the separately started
 * bg-sentinel.mjs (host background Bash task) can pick them up. CLI > cfg file
 * > builtin defaults, resolved inside the sentinel itself.
 *
 * v0.4.1: full v2 key set (sentinel family / staggered graces / fired
 * arbitration) + the rev.b signals block. 0.3.1 keys keep their names and
 * meanings as bridge sources (refire_gap_min←wake_timeout_min,
 * wake_cap←wake_retries — the bridging itself happens in the sentinel).
 *
 * v0.7 (V7-05): the four bridge keys (wake_timeout_min / wake_retries /
 * refire_gap_min / wake_cap) are written SPARSELY — only when the user
 * explicitly passed them on the server CLI (numArgOpt, key absent rather than
 * null). The old unconditional defaults shadowed the sentinel's bridge chain
 * forever: cfg.refire_gap_min (always the finite 5) was consulted before the
 * bridge source cfg.wake_timeout_min, so --wake-timeout-min never reached the
 * refire gap. An absent key reads as NaN in the sentinel's numArgBridge and
 * falls through to its builtin default (5/3 — same numbers as the old server
 * defaults, zero drift). The remaining v2 keys kept writing their recommended
 * defaults unconditionally (numerically equal to the sentinel builtins; the
 * signals block must stay constant).
 *
 * v0.9 (C8): full-sparse mode promoted — every v2 key now goes through
 * numArgOpt and is written ONLY when explicitly passed. An absent key reads
 * NaN in the sentinel and falls through to its builtin default; the zero-drift
 * audit (server default == sentinel builtin, same clamp, all 10 keys) is
 * recorded in tests/assertions/v0.9.x.md (A-v090-CLN-05). The server can no
 * longer shadow a future sentinel-side default change (second-order shadow
 * eliminated). The signals block stays unconditional — the sentinel has no
 * equivalent builtin-default surface for it, so a constant write shadows
 * nothing.
 */
function writeSentinelCfg() {
  try {
    const argv = process.argv.slice(2);
    // —— v0.9 (C8) full-sparse: the signals block is the only unconditional
    //    write; every v2 key is conditionally appended below (numArgOpt). An
    //    absent key lets the sentinel's numArg/numArgBridge read NaN and fall
    //    through to its builtin default (zero-drift audited, table in
    //    tests/assertions/v0.9.x.md) — the server can never shadow a future
    //    sentinel-side default change. ——
    const cfg = {
      // —— rev.b signals block: empty string = sentinel-side default ——
      signals: {
        rollout_dir: "", // default <homedir>/.zcode/cli/rollout
        tool_usage_db: "", // default <homedir>/.zcode/cli/db/db.sqlite (ro, tool_usage only)
        coord_session_file: "sentinel/coord-session.txt",
        mailbox_root: "", // default ZCODE_MAILBOX_ROOT ?? <homedir>/.zcode/mailbox
        toast_on_abandon: true,
      },
    };
    // —— v2 keys, sparse (v0.9 C8): written only when explicitly passed.
    //    Clamps match the sentinel-side ranges; family_size / wake_retries /
    //    wake_cap are rounded like their numArg predecessors. ——
    const vPoll = numArgOpt(argv, "--poll-sec", 1, 3600);
    if (vPoll !== null) cfg.wake_poll_sec = vPoll;
    const vWakeGrace = numArgOpt(argv, "--sentinel-grace-min", 0.01, 1440);
    if (vWakeGrace !== null) cfg.wake_grace_min = vWakeGrace;
    const vAnswerGrace = numArgOpt(argv, "--answer-grace-min", 0.01, 1440);
    if (vAnswerGrace !== null) cfg.answer_grace_min = vAnswerGrace;
    const vStallGrace = numArgOpt(argv, "--stall-grace-min", 0.01, 1440);
    if (vStallGrace !== null) cfg.stall_grace_min = vStallGrace;
    const vCrashGrace = numArgOpt(argv, "--crash-grace-min", 0.01, 1440);
    if (vCrashGrace !== null) cfg.crash_grace_min = vCrashGrace;
    const vCoordIdle = numArgOpt(argv, "--coord-idle-min", 0.01, 1440);
    if (vCoordIdle !== null) cfg.coord_idle_min = vCoordIdle;
    const vCapWindow = numArgOpt(argv, "--cap-window-min", 1, 10080);
    if (vCapWindow !== null) cfg.cap_window_min = vCapWindow;
    const vFamily = numArgOpt(argv, "--sentinel-family", 1, 5);
    if (vFamily !== null) cfg.family_size = Math.round(vFamily);
    const vStagger = numArgOpt(argv, "--stagger-sec", 0, 600);
    if (vStagger !== null) cfg.stagger_sec = vStagger;
    const vLifetime = numArgOpt(argv, "--max-lifetime-min", 0.01, 43200);
    if (vLifetime !== null) cfg.max_lifetime_min = vLifetime;
    // —— bridge keys (0.3.1 wake_timeout_min / wake_retries + v2 refire_gap_min /
    //    wake_cap): written only when explicitly passed — an absent key lets the
    //    sentinel's numArgBridge (CLI > cfg[new key] > cfg[bridge key] > builtin)
    //    see NaN and fall through. Clamps match the sentinel-side ranges. ——
    const vWakeTimeout = numArgOpt(argv, "--wake-timeout-min", 1, 1440);
    if (vWakeTimeout !== null) cfg.wake_timeout_min = vWakeTimeout;
    const vWakeRetries = numArgOpt(argv, "--wake-retries", 1, 100);
    if (vWakeRetries !== null) cfg.wake_retries = Math.round(vWakeRetries);
    const vRefireGap = numArgOpt(argv, "--refire-gap-min", 0.01, 1440);
    if (vRefireGap !== null) cfg.refire_gap_min = vRefireGap;
    const vWakeCap = numArgOpt(argv, "--wake-cap", 1, 100);
    if (vWakeCap !== null) cfg.wake_cap = Math.round(vWakeCap);
    atomicWriteFileSync(path.join(root, "sentinel.cfg.json"), JSON.stringify(cfg, null, 2) + "\n");
  } catch (err) {
    log("sentinel.cfg.json write skipped: " + (err && err.message ? err.message : err));
  }
}
writeSentinelCfg();

/* ------------------------------------------------------------------ */
/* v0.4 startup parameters: sandbox default isolation + claim lease    */
/* ------------------------------------------------------------------ */

/** String argv option: empty / "${" template / unknown -> default. */
function strArg(argv, flag, def) {
  const raw = parseArgValue(argv, flag);
  const s = raw === undefined ? "" : String(raw).trim();
  if (!s || s.startsWith("${")) return def;
  return s;
}

// Only "worktree" opts in; everything else (${/empty/invalid) falls back to none.
const sandboxDefaultArg =
  strArg(process.argv.slice(2), "--sandbox-default", "none") === "worktree" ? "worktree" : "none";
// Lease minutes for board action=claim; report renewals use the same value.
const claimLeaseMinDefault = numArg(process.argv.slice(2), "--claim-lease-min", 30, 1, 1440);
// v0.6 (V6-19A): narrow strict-token switch, DEFAULT OFF. When on:
//   ① report rejects missions with no dispatch.token (fail-closed B4 face —
//     manual-dispatch missions must go through context_pack first);
//   ② agent_harvest accepts only mission_id addressing (session_id/agent_id
//     raw-transcript reads are narrowed to board-mediated lookup);
//   ③ board(claim) unchanged (claim always re-mints, V6-14 — nothing to steal).
// Off = exact v0.5.1 behavior for the no-token face (AUTH-03 baseline).
const strictTokens = process.argv.slice(2).includes("--strict-tokens");
// v0.7 (V7-02, P2P): open p2p record TTL in minutes — gcP2pFiles flips overdue
// records to expired (with the two-sided echo) at startup and lazily on
// p2p_ask / p2p_answer / board list (a time-driven expiry has no other ticker).
const p2pTtlMinDefault = numArg(process.argv.slice(2), "--p2p-ttl-min", 30, 1, 1440);

export {
  memoryRoot,
  ORCH_MD_FILE,
  globalLessonsFile,
  sandboxDefaultArg,
  claimLeaseMinDefault,
  strictTokens,
  p2pTtlMinDefault,
};
