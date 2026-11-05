---
description: "创建自定义子代理角色（写入项目代理目录）"
argument-hint: "<名称> <描述> [archetype] [model]"
---

创建自定义子代理角色。解析"用户附加参数"（按空白分词；参数可用引号包裹含空白的分词）：

| 位置 | 含义 | 取值 |
|---|---|---|
| 第 1 词 | 名称（小写字母/数字/连字符，首字符限 a-z0-9） | "$1" |
| 第 2 词 | 描述（≥10 字） | "$2" |
| 第 3 词 | archetype（worker\|scout\|reviewer，缺省 worker） | "$3" |
| 第 4 词 | model（providerId/modelId，可省略） | "$4" |

步骤：

1. 参数不全 → 向用户追问缺失项；名称与描述不得臆造。
2. 第 4 词非空 → 调用 `ListModels` 校验该 id：不存在或有歧义 → 改用完整 providerId/modelId 重试；`disabledReason` 非空 → 提示用户换 id。
3. 调用 `mcp__plugin_agent-orchestrator_orch__spawn_agent`：`name` 取第 1 词、`description` 取第 2 词；第 3 词非空才传 `archetype`，第 4 词非空才传 `model`；同名角色已存在且用户确认覆盖 → 加 overwrite=true。
4. 向用户展示返回的写入路径，并说明两条生效规则：
   - 项目级角色在新会话注册生效。
   - 当前会话立即使用 → 用 `Agent(prompt=原型正文+system_prompt)` 注入 persona 替代（GP+persona 规则见 `skills/agent-orchestrator/SKILL.md` 第 8 章）。
