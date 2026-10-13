---
description: "总控台：任务板+邮箱+workflow 待答问题一览 / Mission console: board, mailbox and pending workflow questions"
argument-hint: "[mission_id]"
---

总控台巡检。只建议、不执行，等用户选择后再动手。用户附加参数："$ARGUMENTS"（第一个词为可选 mission_id；为空表示查看全部）。

步骤：

1. 若"用户附加参数"第一个词非空：调用 `mcp__plugin_agent-orchestrator_orch__board`（action=get, mission_id="$1"）；否则调用 action=list 列出全部未关闭 mission。
2. 调用 `mcp__plugin_agent-orchestrator_orch__mailbox`（action=peek）查看未读事件与各 mission 最老事件年龄。
3. 对 board 中带 dispatch.run_id 的 mission：调用 `GetWorkflowRun(run_id=…)` 查看运行状态与 pendingQuestions。
4. 输出状态表，每行一个 mission：id｜status｜agent_type/agent_id 或 run_id｜未读数｜blocked 待答？｜最老事件年龄（分钟）｜未签收（取 `board(list)` 返回的 `wake_failure` 字段：非空显示 `疑似(status 于 fmtAge，未签收)`，空显示 `-`）。
5. 对每一项按本插件 SKILL 的"状态→动作决策表"（skills/agent-orchestrator/SKILL.md 第 4 章）给出建议动作，要点：blocked/question 未答→`mailbox(read)` 后作答（`mailbox(answer)`+SendMessage；需查证先派 orch-scout；workflow 用 `ResolveWorkflowQuestion`）；done 未关→聚合产物落盘后 `board(upsert, status=closed)`；workflow stopped/errored→`ResumeWorkflowRun` 或修 script 后 `AmendWorkflow(path)`；running 沉默超 15 分钟→`SendMessage(steer)` 或派 orch-scout 查证；疑似唤醒失败 → `mailbox(read)` 接手 → 处置（answer/close 自动签收）或 `board(action="ack", note="deferred by user")` 暂缓；候选 lessons 待提炼 → `lessons(list, status="candidate")` → 逐条 promote 或放任 gc；沙箱 mission 收尾未做 → 审 diff 抄 qa → sandbox_apply / sandbox_discard（第 17 章）；哨兵健康（board list 的 sentinel_health）→ 家族缺员且有未竟 → 重拉；abandoned 非空 → 立即接手未签收项。
6. 表格之后列出建议动作清单（编号），等用户选择。
