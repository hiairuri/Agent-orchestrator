---
description: "查看或绑定子代理模型（一角色一模型）"
argument-hint: "[角色名] [providerId/modelId]"
---

子代理模型查看与绑定。用户附加参数："$ARGUMENTS"
- 第 1 个词 = 角色名："$1"
- 第 2 个词 = 模型 id："$2"

1. 参数分流：第 1、2 个词均为空 → 执行第 2 步；任一非空 → 执行第 3 步。
2. 无参数分支：调用 `ListModels` 列出可用模型；两轨选择规则以 `skills/agent-orchestrator/SKILL.md` 第 7 章为唯一权威，按其原文说明：普通 Agent 轨三级（Agent 工具无 model 参数）、工作流轨三粒度与优先级；不在本命令维护副本。
3. 有参数分支：调用 `ListModels` 校验第 2 个词（"$2"）。
   - 不存在或有歧义 → 改用完整 providerId/modelId 重试。
   - `disabledReason` 非空 → 提示用户并换 id。
4. 输出三种绑定方式，由用户选择：
   - 角色变体：调用 `mcp__plugin_agent-orchestrator_orch__spawn_agent`（name=第 1 个词加短标签后缀、description=原角色描述或新写、model=第 2 个词；覆盖已有变体时 overwrite=true）。
   - 工作流 run 级：`CreateWorkflow`/`AmendWorkflow` 传 subagent_model=第 2 个词；仅改设置的修改=停旧开新，仅 max_concurrency 可原地修改。
   - 工作流脚本内按子代理：`agent(name, { model: "<providerId/modelId>" })`；或脚本顶部建 ModelRef 表 `const M = { strong: model("<providerId/modelId>") }` 后 `agent(name, { model: M.strong })`。
     - 模型名必须是编译期字面量（可带 `$reasoningLevel` 后缀）或 `model()` 返回的 ModelRef；动态拼名报诊断码 9010。
     - 解析失败（not_found/ambiguous/disabled）报 9011。
     - 启动期对照宿主模型目录校验并经用户确认窗口批准。
     - 改动走 `AmendWorkflow(path)`（取代旧 run、已完成工作零成本导入；缓存命中的旧提问仍返回旧模型结果，仅新发起提问运行新模型）。
