// @module crv2-pack
/*!
 * suites/crv2-pack.mjs —— CRV2-01…08（物化与合流）+ CR-V22（缺省逐字节回归对拍 0.4.1）
 *   + CR-V23（路由全链+沙箱改写）+ CR-V24（截断保序/去重/撞行）+ CR-V25（回退链）+ E1 门
 *
 * 覆盖断言组：A-v050-CRV2-01…08、CR-V18 组的 manifest 维度缺省回归（V22）、输入牵引全链。
 *   转录自 v05-impl-03/rig.mjs + regress-a.mjs + final-assert.mjs（同参对拍改为同进程内
 *   两阶段：0.4.1 基线 server（git d00f94c 导出）与现行 server 先后跑同一固定路径夹具）。
 *
 * 运行方式：node tests/suites/crv2-pack.mjs [--root <临时根>]
 * 前置：node >= 20；PATH 上有 git（d00f94c 基线导出 + worktree 物化）；无网。
 *
 * §0 v1.2.2 施工留痕（design v1.2.2 §4；偏差按行为并集处置，l-20261022-8fa733）：
 *   新增 LSN-01..04（教训转投节）+ TRC-01/02/03/04/05（滞回读侧+边界+文案）；改写
 *   W4-DISPATCH-01（五锚→六锚：+scoping 恒在行；lessons 位次由 LSN-03 七锚钉——本断言
 *   夹具 mkPack 无 LESSONS 节，为 W4-PREFIX-01 head 恒同面免查项（QA-R1 L-3）不加节，
 *   design「五锚→七锚序」按行为并集由 -01 六锚+LSN-03 七锚共同承载）、W4-DISPATCH-04
 *   （「12 块取尾 10」→「12 块 ≤20 全量」滞回语义）。LSN fixture 节头自 server.mjs
 *   源码提取 buildPackMarkdown 真实渲染字面（CT 契约纵深，QA-R1 M-5）。
 *
 * §1 v1.3 W1 初步切分（用户 2026-11-01 裁定：巨型文件先拆散再继续开发；本批=附加处理）：
 *   断言实现体按功能块拆入 ./crv2-pack/*.mjs（setup=共享上下文+辅助、fixtures=夹具构建器、
 *   pack-materialize=基线对拍+物化合流+BUDGET/E1、routing=CR-V23/24/25+不变量、
 *   pack-w2=v0.9 W2、dispatch-runtime=闸门+端到端）。
 *   v1.6 W3a（m-20261104-053000-w16-3a）：dispatch-pure 场景整退役（R1 组装链退役——buildDispatchPrompt
 *   纯区/BUILD-DISPATCH-PURE 标记区随 mcp/tool-dispatch/dispatch-prompt.mjs 整文件退役，31 腿 id 清账；
 *   台账 v1.6.0.md §W3a）。
 *   本文件为薄入口：聚合执行全部断言、Checker 名与 SUITE 输出行格式/总数不变，
 *   run-all REGISTRY 零改动；执行序与拆前逐段等序（阶段 1/1b/2 → 对拍 → 路由 → W2 →
 *   闸门/端到端），异常路径 driver error 断言与 finally 清理语义不变。
 */
import { ck, BASE, proc } from "./crv2-pack/setup.mjs";
import { runPackMaterialize } from "./crv2-pack/pack-materialize.mjs";
import { runRouting } from "./crv2-pack/routing.mjs";
import { runPackW2 } from "./crv2-pack/pack-w2.mjs";
import { runDispatchRuntime } from "./crv2-pack/dispatch-runtime.mjs";

let cur = null;
try {
  ({ cur } = await runPackMaterialize());
  await runRouting(cur);
  await runPackW2(cur);
  await runDispatchRuntime(cur);
} catch (e) {
  ck.ok("driver error", false, (e && e.stack ? e.stack.split("\n").slice(0, 4).join(" | ") : String(e)));
} finally {
  try { proc.cur && proc.cur.close(); } catch {}
  BASE.cleanup();
}
const { fail } = ck.summary();
process.exit(fail ? 1 : 0);
