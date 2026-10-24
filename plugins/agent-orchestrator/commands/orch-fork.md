---
description: "把一项任务分叉为多个并行变体"
argument-hint: "<N> <任务描述>"
---

分叉并行变体。用户附加参数："$ARGUMENTS"
- 第 1 个词 = N（缺省 3，上限 8）："$1"
- 其余部分 = 任务描述：去掉第 1 个词后的剩余文本

步骤：

1. 确定变体轴 variant_axes：任务描述已写明差异维度 → 直接采用；未写明 → 按正交维度推导（不同方案/不同库/不同风格）；无法确定 → 向用户追问，不自行编造。
2. 调用 `mcp__plugin_agent-orchestrator_orch__board`（action=upsert）建 mission：title=任务描述摘要、original_prompt=任务描述全文、agent_type 按任务性质取 orch-worker 或 orch-scout。
3. 调用 `mcp__plugin_agent-orchestrator_orch__context_pack`（mission_id、title、task、variants=N、variant_axes；上游上下文存在时带 upstream_context）取得 N 份任务包与 prompt_templates。
4. 在同一条消息内发出 N 条 `Agent`：subagent_type=第 2 步选定的角色、run_in_background=true、prompt=prompt_templates 对应项。
5. 调用 `board`（action=upsert）把每条派发的 dispatch（mode=agent、agent_id、task_id、session_id）记入 board。
6. 向用户说明等待纪律：不轮询、不阻塞；以完成通知为到达信号；全部到齐后 `mailbox(read)` 消费、比较结果（可派 orch-reviewer 汇总评审），最后聚合落盘并逐个关闭。
