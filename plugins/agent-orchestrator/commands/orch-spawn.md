---
description: "创建自定义子代理角色（写入项目 .zcode/agents）/ Create a custom subagent persona under .zcode/agents"
argument-hint: "<名称> <描述> [archetype] [model]"
---

创建自定义子代理角色。解析"用户附加参数"（按空白分词，参数可含引号包裹的分词）：

| 位置 | 含义 | 值 |
| --- | --- | --- |
| 第 1 词 | 名称（需匹配 a-z0-9 开头的小写字母/数字/连字符） | "$1" |
| 第 2 词 | 描述（至少 10 字） | "$2" |
| 第 3 词 | archetype（worker\|scout\|reviewer，缺省 worker） | "$3" |
| 第 4 词 | model（providerId/modelId，可省） | "$4" |

步骤：

1. 参数不全时先向用户追问缺失项，不要臆造名称或描述。
2. 表中第 4 行非空时：先调用 `ListModels` 校验该 id——不存在或有歧义时改用完整 providerId/modelId 重试；`disabledReason` 非空时提示用户换 id。
3. 调用 `mcp__plugin_agent-orchestrator_orch__spawn_agent`：`"name"` 取第 1 词的值、`"description"` 取第 2 词的值；表中第 3 行非空才传 `"archetype"`、第 4 行非空才传 `"model"`；同名角色已存在且用户确认覆盖时加 overwrite=true。
4. 向用户展示返回的写入路径，并强调两点：项目级角色在**新会话**注册生效；当前会话要立即使用，请用 `Agent(prompt=原型正文+角色专述)` 注入 persona 替代。
