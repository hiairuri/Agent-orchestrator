---
description: "查看/绑定子代理模型（角色一模型）/ Inspect or bind subagent models (one persona, one model)"
argument-hint: "[角色名] [providerId/modelId]"
---

子代理模型查看与绑定。用户附加参数："$ARGUMENTS"
- 第 1 个词 = 角色名："$1"
- 第 2 个词 = 模型 id："$2"

两者均空（""）→ 走"无参数时"分支。

无参数时：调用 `ListModels` 列出可用模型，并说明两轨选择规则：

- 普通 Agent 轨三级：① 用户显式指定（先 ListModels 校验）→ ② 角色绑定（spawn_agent 造角色变体，一角色一模型）→ ③ 继承会话模型。Agent 工具本身没有 model 参数。
- workflow 轨三粒度：① 脚本内 per-agent `agent(name, { model })`；② run 级 `subagent_model`；③ 未指定者继承会话模型。优先级：persona.model > subagent_model > 会话模型。

有参数时（第 1/2 个词任一非空）：

1. `ListModels` 校验第 2 个词（"$2"）：不存在或有歧义 → 改用完整 providerId/modelId；`disabledReason` 非空 → 提示用户并换 id。
2. 输出三种绑定方式，让用户选：
   - 角色变体：调用 `mcp__plugin_agent-orchestrator_orch__spawn_agent`（name=第 1 个词加短标签后缀、description=原角色描述或新写、model=第 2 个词；覆盖已有变体时 overwrite=true）。
   - workflow run 级：`CreateWorkflow`/`AmendWorkflow` 传 subagent_model=第 2 个词（settings-only 的修改=停旧开新，仅 max_concurrency 可 in-place）。
   - workflow 脚本内 per-agent：`agent(name, { model: "<providerId/modelId>" })`，或脚本顶部建 ModelRef 表 `const M = { strong: model("<providerId/modelId>") }` 后 `agent(name, { model: M.strong })`。注明约束：模型名必须是编译期字面量（可带 $reasoningLevel 后缀）或 model() 返回的 ModelRef，动态拼名会报诊断码 9010；解析失败（not_found/ambiguous/disabled）为 9011，用 ListModels 或全 providerId/modelId 解决；启动期会对照 host 模型目录校验并经用户确认窗口批准；改动走 `AmendWorkflow(path)`（supersede 旧 run、已完成工作零成本导入；缓存命中的旧 ask 仍返回旧模型结果，新 live ask 才跑新模型）。
