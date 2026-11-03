// agent-orchestrator orch server — tool: dispatch 薄入口（provenance：v1.5 W2-A T7 裁 a 二拆自 1647 行单文件
// 〔ece2e80 基〕：组装纯区/模型播种/主流程三模块下沉 mcp/tool-dispatch/ 子目录；本件=工具注册导出接线+契约头注，
// 零业务谓词（LM-06 条文 4 入口薄度；软帽 600）。唯一消费方=mcp/server-registry.mjs（import { toolDispatch }）。

/* tool: dispatch (v1.1.1 W20; the 12th tool, coordinator-only)        */
/*                                                                     */
/* Closes the dispatch surface to three calls: board upsert →          */
/* context_pack → dispatch(mission_id). The launcher assembles the      */
/* first message (v1.1.2 I1 四段式 + v1.2.2 教训节——数据簇终序：        */
/* tail trace → digest → pack LESSONS transfer → scoping line → persona */
/* → pointer sentence + CONTRACT three lines), writes an audit prompt   */
/* under context/dispatch-logs/, detached-spawns hooks/dispatch-runner  */
/* (which runs `zcode -p <prompt> --json --mode yolo` and records the   */
/* result envelope under context/dispatch-results/), and returns within */
/* seconds with the captured session id (rollout diff ≤5s; missing →    */
/* session_pending:true, the result index backfills it later).          */
/* Completion stays on the existing report/mailbox/sentinel chain — the */
/* result files are the post-mortem diagnostic face only (the runner    */
/* never writes the board: the root lock is server-owned).              */
/* ------------------------------------------------------------------ */


// 族布局（LM-06 族面规范条文 1「入口+同名子目录」；FAMILIES 9 族）：
//   mcp/tool-dispatch/dispatch-prompt.mjs — 组装纯区（BUILD-DISPATCH-PURE 标记区+角色常量，crv2/t11/m91 rig 直测载体）
//   mcp/tool-dispatch/dispatch-model.mjs — 模型选型两源+拥塞戳域
//   mcp/tool-dispatch/dispatch-core.mjs  — resolve/读取+哨兵/组合捕获+provider env+播种配置+主流程（软帽豁免登记件）

export { toolDispatch } from "./tool-dispatch/dispatch-core.mjs";
