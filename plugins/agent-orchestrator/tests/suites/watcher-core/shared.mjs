// @module suites/watcher-core/shared
/*!
 * watcher-core/shared.mjs —— 套件级共享面：Checker 实例 + 小工具 + 零触网硬护栏。
 * 拆分自 suites/watcher-core.mjs（v1.3 巨型文件拆分；断言本体零改动，纯搬运+接线）。
 */
import { Checker } from "../../harness/jsonrpc-client.mjs";

export const ck = new Checker("watcher-core");
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const grp = (n) => process.stderr.write("[grp] " + n + "\n");
export const b64url = (s) => Buffer.from(s, "utf8").toString("base64url");

/* 零触网硬护栏（EXP 纪律运行时化）：套内任何路径漏注入 fetchImpl 也只能打到本 stub——
   真实中继/签发端点/任何远端一律禁触；漏注入表现为快速失败（network）而非静默外呼。 */
globalThis.fetch = async (url) => {
  throw Object.assign(new Error("suite-net-forbidden: " + String(url)), { name: "SuiteNetForbidden" });
};
