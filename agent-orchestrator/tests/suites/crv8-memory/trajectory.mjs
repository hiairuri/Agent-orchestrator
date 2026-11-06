// @module crv8-memory/trajectory
/*!
 * suites/crv8-memory/trajectory.mjs —— trajectory 写面场景（v1.6 W-t 新建，design §2.2/§3.3 N15①；
 *   grill#3 OPEN-1 终裁「废除原写面，用 MCP 写面」——stop-check 写段拆除（R7）后，项目记忆轨迹
 *   唯一写面=server trajectory 工具（第 13 号，主控专属单 action append）。本场景承载 N15① cap
 *   行为腿/协议行 server 铸/滞回裁回/超帽 isError/ORT 格式逐字五腿组 + flying 自动补全/回执/
 *   参数校验/短形 server 侧合并/跨会话 seq 单调（v2 legacy 计数承袭）。
 *   写面契约：落盘 <存储根>/context/coord-tail-log.md；协议行 ts=调用时点、seq=文件内最大 seq+1
 *   （跨会话单调，取代旧「会话内单调」）；20/10 滞回（第 21 块触发原子重写裁回最新 10）；
 *   帽=全形 ≤10 行/900B、短形 ≤6 行/400B，超帽=ToolError 当场拒（isError 化——旧静默拒写改善）；
 *   短形入日志=server 合并后的全形块（coordTailMerge 语义承袭）；防回潮反向钉=po-static N15。
 */
import fs from "node:fs";
import path from "node:path";
import { ck, subRoot, startServerX } from "./shared.mjs";

const MARK = "<!-- orch-tail v3";
const CLOSE = "<!-- orch-tail-end -->";

/** ORT v3 全形块（夹具构造器；seq 供直投种子用——server 写面块由 server 铸 ts/seq）。 */
const fullBlock = (over = {}) =>
  [
    MARK,
    `ts: ${over.ts ?? "2026-11-04T05:00:00.000Z"}`,
    `seq: ${over.seq ?? 1}`,
    `project: ${over.project ?? "v1.6 施工"}`,
    `stage: ${over.stage ?? "W-t"}`,
    `flying: ${over.flying ?? "m-a"}`,
    `ruled: ${over.ruled ?? "轨迹写面换装"}`,
    `next: ${over.next ?? "收口"}`,
    CLOSE,
  ].join("\n");

/** v2 legacy 全形块（跨会话 seq 单调 + 双标计数腿的种子载体；存量保留不回写语义）。 */
const legacyV2Block = (over = {}) =>
  [
    "<!-- orch-tail v2",
    `ts: ${over.ts ?? "2026-10-25T05:00:00.000Z"}`,
    `seq: ${over.seq ?? 40}`,
    `project: ${over.project ?? "旧写面存档"}`,
    `stage: ${over.stage ?? "W20"}`,
    `flying: ${over.flying ?? "m-old"}`,
    `ruled: ${over.ruled ?? "日志唯一源"}`,
    `next: ${over.next ?? "机制波"}`,
    CLOSE,
  ].join("\n");

export async function scenTrajectory() {
  const R = subRoot("r-traj");
  const LOG = path.join(R, "context", "coord-tail-log.md");
  const readLog = () => (fs.existsSync(LOG) ? fs.readFileSync(LOG, "utf8") : null);
  const scanBlocks = (text) => {
    const lines = String(text ?? "").split(/\r?\n/);
    const out = [];
    let open = -1;
    for (let i = 0; i < lines.length; i++) {
      const t = lines[i].trim();
      if (t === MARK || t === "<!-- orch-tail v2") open = i;
      else if (t === CLOSE && open >= 0) {
        out.push(lines.slice(open, i + 1).join("\n"));
        open = -1;
      }
    }
    return out;
  };
  const s = startServerX({ root: R });
  try {
    const call = (args) => s.call("trajectory", args);

    // ---- TRAJ-01：全形 append——ORT v3 格式逐字 + 协议行 server 铸（ts=调用时点/seq=1）+ 回执
    const r1 = await call({ kind: "full", project: "v1.6 施工", stage: "W-t", ruled: "轨迹写面换装", next: "收口" });
    const got1 = readLog();
    const tsOk = /^ts: \d{4}-\d{2}-\d{2}T/.test((got1 ?? "").split("\n")[1] ?? "");
    ck.ok(
      "TRAJ-01 全形 append：ORT v3 块逐字（标记对/字段行序 project,stage,flying,ruled,next）∧ 协议行 server 铸（ts=调用时点 ISO8601、seq: 1）∧ 回执 {ok:true, seq:1, blocks:1, trimmed:false}",
      r1.isError === false &&
        r1.json && r1.json.ok === true && r1.json.seq === 1 && r1.json.blocks === 1 && r1.json.trimmed === false &&
        got1 === [
          MARK,
          got1 ? got1.split("\n")[1] : "",
          "seq: 1",
          "project: v1.6 施工",
          "stage: W-t",
          "flying: 无",
          "ruled: 轨迹写面换装",
          "next: 收口",
          CLOSE,
          "",
        ].join("\n") &&
        tsOk,
      { json: r1.json, err: r1.text, head: got1 && got1.split("\n").slice(0, 3) },
    );

    // ---- TRAJ-02：短形 delta——server 侧合并入全形块（project/stage/ruled 继承、flying +/-、seq 递增）
    const r2 = await call({ kind: "short", flying: "+m-b,-m-a", next: "稳态轮" });
    const got2 = scanBlocks(readLog());
    ck.ok(
      "TRAJ-02 短形 delta server 侧合并：落盘=合并后全形块（project/stage/ruled 自全形基线继承〔跨会话取代旧同会话链〕∧ flying 增删 m-b ∧ seq: 2）∧ 回执 blocks:2",
      r2.isError === false && r2.json && r2.json.ok === true && r2.json.seq === 2 && r2.json.blocks === 2 && r2.json.trimmed === false &&
        got2.length === 2 &&
        got2[1] === fullBlock({ ts: (got2[1] ?? "").split("\n")[1]?.replace(/^ts: /, "") ?? "", seq: 2, flying: "m-b", next: "稳态轮" }),
      { json: r2.json, last: got2[1] },
    );

    // ---- TRAJ-03：短形无全形基线 → isError 当场拒（日志零产生）
    {
      const R3 = subRoot("r-traj-nobase");
      const s3 = startServerX({ root: R3 });
      try {
        const r3 = await s3.call("trajectory", { kind: "short", next: "无基线" });
        ck.ok(
          "TRAJ-03 短形无全形基线：isError 当场拒（error 含「missing the full-form baseline」）∧ 日志零产生",
          r3.isError === true && (r3.text ?? "").includes("missing the full-form baseline") &&
            !fs.existsSync(path.join(R3, "context", "coord-tail-log.md")),
          { err: r3.text, exists: fs.existsSync(path.join(R3, "context", "coord-tail-log.md")) },
        );
      } finally {
        s3.close();
      }
    }

    // ---- TRAJ-04：参数校验三支（kind 缺失 / full 缺 project / 全形 flying 禁 +/-）→ 全 isError
    const e1 = await call({});
    const e2 = await call({ kind: "full", stage: "s", ruled: "r", next: "n" });
    const e3 = await call({ kind: "full", project: "p", stage: "s", flying: "+m-x", ruled: "r", next: "n" });
    ck.ok(
      "TRAJ-04 参数校验（帽校验 isError 化伴腿）：kind 缺失 / full 缺 project / 全形 flying 携 +/- 前缀 三支全 isError",
      e1.isError === true && e2.isError === true && e3.isError === true &&
        (e3.text ?? "").includes("+/-"),
      { e1: e1.text, e2: e2.text, e3: e3.text },
    );

    // ---- TRAJ-05：flying 缺席自动补全（board running/dispatched 清单，最近更新优先，≤3 条）
    {
      const R5 = subRoot("r-traj-board");
      fs.writeFileSync(
        path.join(R5, "board.json"),
        JSON.stringify({
          version: 2,
          missions: [
            { id: "m-done", status: "done", updated_at: "2026-11-04T09:00:00.000Z" },
            { id: "m-disp", status: "dispatched", updated_at: "2026-11-04T08:00:00.000Z" },
            { id: "m-run", status: "running", updated_at: "2026-11-04T07:00:00.000Z" },
            { id: "m-old", status: "running", updated_at: "2026-11-04T06:00:00.000Z" },
          ],
        }) + "\n",
      );
      const s5 = startServerX({ root: R5 });
      try {
        const r5 = await s5.call("trajectory", { kind: "full", project: "补全腿", stage: "W-t", ruled: "r", next: "n" });
        const block5 = scanBlocks(fs.readFileSync(path.join(R5, "context", "coord-tail-log.md"), "utf8"))[0] ?? "";
        ck.ok(
          "TRAJ-05 flying 缺席自动补全：board running/dispatched 清单（done 排除）∧ 最近更新优先（m-disp,m-run 取前 3；第 4 项 m-old 截断=显式传 flying 承载全景）",
          r5.isError === false && block5.includes("flying: m-disp, m-run, m-old"),
          { flyingLine: block5.split("\n").find((l) => l.startsWith("flying: ")) },
        );
      } finally {
        s5.close();
      }
    }

    // ---- TRAJ-06：全形超帽（>900B）→ isError 当场拒 + 日志逐字节不动
    {
      const before6 = readLog();
      const r6 = await call({ kind: "full", project: "x".repeat(950), stage: "s", ruled: "r", next: "n" });
      ck.ok(
        "TRAJ-06 全形超帽（>900B）：isError 当场拒（error 含「over cap」）∧ 日志逐字节保留（旧静默拒写改善为调用即知）",
        r6.isError === true && (r6.text ?? "").includes("over cap") && readLog() === before6,
        { err: (r6.text ?? "").slice(0, 80), unchanged: readLog() === before6 },
      );
    }

    // ---- TRAJ-07：20/10 滞回（第 21 块触发原子重写裁回最新 10，含新块；seq 跨越种子连续）
    fs.mkdirSync(path.dirname(LOG), { recursive: true });
    fs.writeFileSync(
      LOG,
      Array.from({ length: 20 }, (_, k) => fullBlock({ seq: k + 1, next: "n" + (k + 1) })).join("\n\n") + "\n",
    );
    const r7 = await call({ kind: "full", project: "滞回腿", stage: "W-t", ruled: "r", next: "n21" });
    const got7 = scanBlocks(readLog());
    const seqs7 = got7.map((b) => /^seq: (\d+)$/m.exec(b)?.[1]);
    ck.ok(
      "TRAJ-07 滞回 20/10：恰 20 块 + 第 21 块 → 原子重写保留最新 10（seq1..11 出队、seq12..20+新块 seq: 21 在位）∧ 回执 {blocks:10, trimmed:true}",
      r7.isError === false && r7.json && r7.json.blocks === 10 && r7.json.trimmed === true && r7.json.seq === 21 &&
        got7.length === 10 &&
        seqs7[0] === "12" && seqs7[9] === "21" &&
        !readLog().includes("next: n11") && got7[9].includes("next: n21"),
      { json: r7.json, count: got7.length, first: seqs7[0], last: seqs7[9] },
    );

    // ---- TRAJ-08：seq 跨会话单调（v2 legacy 块计数承袭）——文件含 v2 seq:40 → 新块 seq: 41
    fs.writeFileSync(LOG, legacyV2Block({ seq: 40 }) + "\n");
    const r8 = await call({ kind: "full", project: "跨会话腿", stage: "W-t", ruled: "r", next: "n" });
    const got8 = scanBlocks(readLog());
    ck.ok(
      "TRAJ-08 seq 跨会话单调（取代旧「会话内单调」声明强化）：v2 legacy 块 seq:40 计入最大值 → 新块 seq: 41 ∧ v2 存量块原样保留不回写（C2-05 容忍半面承袭）",
      r8.isError === false && r8.json && r8.json.seq === 41 &&
        got8.length === 2 && got8[0] === legacyV2Block({ seq: 40 }) && got8[1].includes("seq: 41"),
      { json: r8.json, count: got8.length, first: got8[0].split("\n")[0] },
    );
  } finally {
    s.close();
  }
}
