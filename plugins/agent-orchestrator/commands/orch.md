---
description: "总控台：任务板、邮箱与工作流待答问题一览"
argument-hint: "[mission_id]"
---

总控台巡检。只输出建议、不执行写操作；用户选定后再执行。用户附加参数："$ARGUMENTS"（第一个词为可选 mission_id；为空表示查看全部）。

步骤：

1. 参数分流：第一个词非空 → 调用 `mcp__plugin_agent-orchestrator_orch__board`（action=get, mission_id="$1"）；为空 → 调用 action=list 列出全部未关闭 mission。
2. 调用 `mcp__plugin_agent-orchestrator_orch__mailbox`（action=peek）取未读事件与各 mission 最老事件年龄。
3. 遍历 board 中带 dispatch.run_id 的 mission：调用 `GetWorkflowRun(run_id=…)` 取运行状态与 pendingQuestions。
4. 输出状态表，一行一个 mission，列固定为：id｜status｜agent_type/agent_id 或 run_id｜未读数｜blocked 待答？｜最老事件年龄（分钟）｜未签收。
   - A5 视图口径：默认 `board(list)` 紧凑行已剔除内部态字段，勿从 list 行读取。
   - 未签收列取值：对表内每个 mission 调用 `board`（action=get, mission_id=…）读详单 `wake_failure`（默认 compact 视图保留内部态，无需 view:"full"）：非空 → `疑似(status 于 fmtAge，未签收)`；为空 → `-`。
5. 对表中每一项，按 `skills/agent-orchestrator/SKILL.md` 第 4 章「状态→动作决策表」匹配一行取建议动作（该表为唯一权威，本命令不复述）；本步骤只出建议、不改状态。
   命令面专属输入：未签收列取 `board(get)` 详单的 `wake_failure`（默认 compact 保留内部态）。
   哨兵健康取 `board(list)` 顶层 `sentinel_health`。

6. 表格之后列出编号建议动作清单，等用户选择。
