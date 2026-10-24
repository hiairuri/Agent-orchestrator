---
description: "恢复中断任务：本会话续聊、工作流续跑、跨会话接力"
argument-hint: "[mission_id]"
---

恢复中断任务。用户附加参数："$ARGUMENTS"（可选的单个 mission_id；为空表示恢复全部）。

步骤：

1. 调用 `mcp__plugin_agent-orchestrator_orch__resume`（session_id=当前会话 id，已知时传入）取得简报。
   - "用户附加参数"非空 → 只处理该 mission（id 取 "$1"）。
   - "用户附加参数"为空 → 处理全部 mission。
2. 对每个 mission 读取 recommended_action，按下表执行对应动作：

|条件|动作|
|---|---|
|mode=workflow 且 run stopped|`ResumeWorkflowRun(run_id)`；用户主动停止的先询问用户|
|mode=workflow 且 run errored|先读错误、修改脚本文件，再 `AmendWorkflow(run_id, path=脚本文件)`；禁止用 CreateWorkflow 重写|
|mode=agent 且 dispatch.session_id=当前会话且已终态|`SendMessage(to=agent_id, summary≤200, message=继续指令)` 恢复续聊|
|跨会话或无 agentId|用 `context_pack`（board 存有 original_prompt 与任务包路径）重建上下文，再按同类型角色重新派发；agentId 跨会话无效|
|blocked 未答|`mailbox(read)` 消费提问 → 不确定时派 orch-scout 查证 → `mailbox(answer)` 并按 recommended_call 发 SendMessage|
|疑似唤醒失败（wake_failure 非空）|`mailbox(read)` 接手 → answer/close 自动签收，或 `board(action="ack", note="deferred by user")` 暂缓|
|status=done 未关|聚合产物 → `board(upsert, status=closed)`|
|有在飞任务且哨兵未启动|`Bash(command="node <插件根>/hooks/bg-sentinel.mjs --once", run_in_background=true)` 拉起哨兵；收到哨兵告警按「疑似唤醒失败」行处置；处置后可重启哨兵|
|sentinel_health 缺员或 abandoned 非空|补员（同命令再发至满编）+ 接手 abandoned 未签收项|
|跨会话现场（prev_sessions.tail 非空）|先读镜像尾部摘要还原现场；需深挖再用 `ReadSessionContext(sessionId="…", strategy="handoff")`|
|候选 lessons（本次接手的 done/failed 涉及踩坑）|`lessons(list, status="candidate")` → promote 或放任 gc；failed 补 error-fix 反思|
|ready_unclaimed 非空|派池工领取，或手动派发|
|skipped|复核后关闭，或修订 blockedBy 重规划|

3. 每项执行后调用 `mcp__plugin_agent-orchestrator_orch__board`（action=upsert）更新状态，并把 dispatch.session_id 更新为当前会话 id。
4. 向用户汇报处置清单：恢复了什么、跳过什么、原因。
