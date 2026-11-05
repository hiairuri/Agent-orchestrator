// @module sentinel-teardown/fixtures
/*!
 * suites/sentinel-teardown/fixtures.mjs —— 哨兵 teardown 套件共享夹具与辅助
 * （自 sentinel-teardown.mjs 初步切分拆出，v1.3；函数体逐字搬运零行为变更）
 *
 * 内容 = 原文件夹具区（sleep/waitFor/readJson/readText/countLines/slotFile/SID/
 * writeAnchor/writeBoard/spawnSentinel/writeMarker）+ 原 T7 前共享辅助
 * （cleanSlots/firedCount，T7/T8/T9/T10 跨组共用故上移共享）。
 * 入口经 createFixtures(deps) 组装 ctx 传给各断言模块，模块内解构后引用名与原文件一致。
 */
import fs from "node:fs";
import path from "node:path";
import { captureBackground } from "../../harness/capture.mjs";

// v1.2 M9-1 scoping：本套件夹具的「本哨兵锚」会话 id——期望开枪的 mission 一律
// dispatch.session_id=SID（归属等值判定正例）；SCP 组负例用他值/缺省。
export const SID = "sess_coord";

export function createFixtures({ SENTINEL, PROJ, ROOT, SENT_DIR, MARKER, ECHO, kids }) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  async function waitFor(fn, timeoutMs, step = 120) {
    const t0 = Date.now();
    for (;;) {
      if (fn()) return true;
      if (Date.now() - t0 > timeoutMs) return false;
      await sleep(step);
    }
  }
  const readJson = (f) => {
    try {
      return JSON.parse(fs.readFileSync(f, "utf8"));
    } catch {
      return null;
    }
  };
  const readText = (f) => {
    try {
      return fs.readFileSync(f, "utf8");
    } catch {
      return "";
    }
  };
  const countLines = (f) => readText(f).split("\n").filter((x) => x.trim()).length;
  const slotFile = (k) => path.join(SENT_DIR, `instance-${k}.json`);
  const writeAnchor = (sid = SID) => {
    fs.mkdirSync(SENT_DIR, { recursive: true });
    fs.writeFileSync(path.join(SENT_DIR, "coord-session.txt"), sid + "\n");
  };
  const writeBoard = (missions) => {
    fs.mkdirSync(ROOT, { recursive: true });
    fs.writeFileSync(
      path.join(ROOT, "board.json"),
      JSON.stringify({ version: 2, updated_at: new Date().toISOString(), missions }) + "\n",
    );
  };
  /** 拉起一个哨兵实例（后台捕获；加速参数：1s poll / 0 stagger / 2s 待命复核） */
  const spawnSentinel = ({ missions, lifetimeMin = null, standbyPollSec = 2 } = {}) => {
    if (missions) writeBoard(missions);
    writeAnchor(); // v1.2 M9-1：夹具恒布锚（scoping 等值判定本侧；无锚=全部 mission 被 scoping 跳过）
    const args = [SENTINEL, "--root", ROOT, "--poll-sec", "1", "--stagger-sec", "0", "--standby-poll-sec", String(standbyPollSec)];
    if (lifetimeMin != null) args.push("--max-lifetime-min", String(lifetimeMin));
    const bg = captureBackground({ script: process.execPath, args, cwd: PROJ, env: { ZCODE_PROJECT_DIR: PROJ } });
    kids.push(bg);
    return bg;
  };
  const writeMarker = (atMs, pid = 1, slot = 0) => {
    fs.mkdirSync(SENT_DIR, { recursive: true });
    fs.writeFileSync(MARKER, JSON.stringify({ at: new Date(atMs).toISOString(), pid, slot }) + "\n");
  };
  const cleanSlots = () => {
    for (const n of fs.readdirSync(SENT_DIR).filter((n) => /^instance-\d+\.json$/.test(n))) {
      fs.rmSync(path.join(SENT_DIR, n), { force: true });
    }
  };
  const firedCount = () => {
    try {
      return fs.readdirSync(path.join(SENT_DIR, "fired")).length;
    } catch {
      return 0;
    }
  };
  return { SID, sleep, waitFor, readJson, readText, countLines, slotFile, writeAnchor, writeBoard, spawnSentinel, writeMarker, cleanSlots, firedCount };
}
