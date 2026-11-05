// @module crv6-statemachine/dispatch-fa
/*!
 * suites/crv6-statemachine/dispatch-fa.mjs —— v1.6 W-p 剥离波退役空壳（W2 scene6b 先例同型）
 *
 *   原 FA-1..5（v1.1.1-FA dispatch headless 修复波断言：模型供给播种/失败显式化/
 *   秒死注入/慢启动捕获，根因权威=designs/agent-orchestrator-v1.1.1-dispatch-bug-findings.md）
 *   全部驱动 headless 派发面（dispatchSeedModelConfig/busy index 闸/≤8s 组合捕获/桩 CLI
 *   spawn）——v1.6 W-p 随 -p 通道整体迁 parked/agent-orchestrator/（dispatch-model.mjs+
 *   dispatch-runner.mjs git rm、dispatch-core headless 分支拆除、mode enum 收窄 ["nested"]），
 *   五腿 subject 消亡即全数退役（波首对拍实态 5/5，非计划预判 4迁1留——台账 v1.6.0.md §W-p）。
 *
 *   文件保留空壳原因：入口 tests/suites/crv6-statemachine.mjs（本波 scope 外）import/调用
 *   接线零触（W2 先例：函数签名保留=入口接线零改动）；断言本体沿革由
 *   tests/assertions/v1.1.x.md A-v111-FA-01 沿革注记+v1.6.0.md §W-p 承载；恢复=
 *   parked/agent-orchestrator/README.md 指引回植后按 FA 原语义重接。
 */
export async function run(ctx) {
  const { sleep } = ctx;
  // v1.6 W-p 退役空壳：零断言腿（FA-1..5 随 headless 面迁 parked）；尾置 sleep(0)
  // 事件落盘窗口兜底惯例保留（原 FA-5 尾句）。
  if (typeof sleep === "function") await sleep(0);
}
