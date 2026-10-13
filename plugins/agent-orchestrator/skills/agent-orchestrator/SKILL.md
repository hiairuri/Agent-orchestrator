---
name: agent-orchestrator
description: "主控操作手册：把主控 agent 变成任务指挥官。当需要（a）派发/并行/分叉多个子代理并持续跟踪；（b）子代理后台跑、主控同时继续别的活；（c）子代理阻塞提问、主控作答后让它继续；（d）同会话或跨会话恢复中断的任务；（e）给不同子代理/角色选不同模型；（f）运行时创建自定义角色；（g）沉淀与复用编排教训（lessons）；（h）任务完成未签收时被哨兵叫醒；（i）跨会话引用近期会话现场（上下文镜像）；（j）把写代码任务隔离进 git worktree 沙箱并安全合并；（k）任务依赖编排与池工自领取；（l）多轮迭代流水线并行推进——任一情况都使用本技能。含三行契约派发、任务板与邮箱轮询、SendMessage 恢复与 steer、ResumeWorkflowRun/AmendWorkflow、含结果签收与疑似唤醒失败检测、前台派发后台闸门、lessons 经验沉淀、唤醒哨兵与上下文镜像。Stop 收工提醒处置。"
---

# agent-orchestrator：主控操作手册

本技能的使用者是**主控 agent**（你）。子代理不会加载本文件——它们的世界只有任务包与 report 工具。

## 1. 何时用 + 概念图

何时用：要并行派发多个子代理、要子代理后台跑自己继续干活、要分叉对比方案、要回答子代理的阻塞提问、要恢复中断的任务、要给不同子代理选不同模型、要运行时造新角色——任一情况。

```
主控（你，唯一轮询者与答题者）
 ├─ Agent(run_in_background=true) ──→ 子代理（orch-worker / orch-scout / orch-reviewer）
 │       ↑ prompt = 三行契约派发头 + 任务包路径          │
 │       ← 完成通知（含输出文件路径）                     │ 用 report 工具写事件
 ├─ board.json   任务板：mission 状态机、dispatch、产物、timeline（MCP 工具 board）
 └─ spool/       邮箱：unread →(rename)→ read；answers/ 留痕（MCP 工具 mailbox）
```

- **任务板（board.json）**：跨会话恢复的数据源；每条 mission 有 id、状态机、dispatch 信息、pack 路径、产物。
- **邮箱（spool/）**：子代理 report 的事件落盘；`mailbox(peek)` 看不消费，`mailbox(read)` rename 消费。
- **三行契约**：`[channel]/[worker]/[token]` 三行出现在派发 prompt 头部与任务包 CONTRACT 节，防误报、可对账。
- 铁律：**主控是唯一轮询者与答题者**；子代理之间禁止互调（星型拓扑）。
- **教训库（memory/lessons.jsonl）**：两级写入的编排/过程教训（MCP 工具 lessons 检索与晋升）。**唤醒哨兵（hooks/bg-sentinel.mjs）**：你以后台任务启动，退出即通知——全清自毁、超时告警叫醒你。**上下文镜像（context/journal-*.jsonl）**：提示词与回复的截断落盘记录，支撑跨会话现场引用。

## 2. 标准派发七步

1. `board(action=upsert, mission={title, original_prompt, agent_type, status:"drafted"})` 建 mission——**original_prompt 必填**（跨会话恢复的种子）。
2. `context_pack(mission_id, title, task, read_first, rules, upstream_context)` 生成任务包 + token + prompt_template。
3. `Agent(description, subagent_type="agent-orchestrator:orch-worker", prompt=prompt_template + 任务要点, run_in_background=true)` 派发。
4. `board(upsert, mission={id, status:"running", dispatch={mode:"agent", agent_id, task_id, session_id, run_in_background:true}})` 记录派发；**并（本回合首次派发时）后台拉起唤醒哨兵**：`Bash(command="node <插件根>/hooks/bg-sentinel.mjs --once", run_in_background=true, description="哨兵：未签收任务超时叫醒")`——全部签收它静默自毁，超时未签收它告警叫醒你（超时/重试/间隔默认取 userConfig，可 CLI 覆盖；详见第 14 章）。
5. **不等**：继续干别的活。同一消息里放多条 Agent 调用 = 并发（上限约 8）。
6. 完成通知到达后：读通知里的输出文件路径（兜底）→ `mailbox(action=read)` 消费事件。
7. 聚合落盘（结果写文件，只把摘要带进上下文）→ `board(upsert, mission={id, status:"closed"})`。（close 会自动补签收 ack；done 附带的候选 lessons 在此时 `lessons(action="promote")` 提炼晋升或放任 gc；本回合全部处置完且哨兵在值守，它会自行自毁，无需手动停）

角色选择：动手改代码用 `orch-worker`；纯调研查证用 `orch-scout`；验收评审用 `orch-reviewer`。

## 3. 派发包模板（context_pack 与三行契约派发头）

任务包（`context_pack` 自动生成，主控不用手写）：

````markdown
# 任务包：{title}（{mission_id}）

## CONTRACT（三行契约，也出现在派发 prompt 头部）
[channel] {mission_id}
[worker] {worker 名，如 orch-worker#1}
[token] {token}
进度与结果一律用 mcp__plugin_agent-orchestrator_orch__report 上报；
kind ∈ {milestone, blocked, question, done}；summary ≤ 200 字；done 必带 artifacts 路径。

## CONTEXT（上游产物，逐字注入——你当时不在场）
{upstream_context 或 "（无）"}

## READ FIRST
- {path1}
- {path2}

## TASK
{task}

## RULES
- 只在本包范围内工作，不改包外文件
- 受阻/目标矛盾/必败门禁：立即 report(kind=blocked, question=…)，不硬扛不造假
- {rules...}

## VARIANT（仅分叉变体 v{k}）
{variant_axes[k] 或 "（无）"}

## RETURN
- 做了什么（3–6 条）
- 产物/输出文件路径
- 遗留问题与建议
- 验证/测试结果（如适用）
````

派发 prompt 头（`context_pack` 返回的 `prompt_template`，逐字粘贴进 Agent prompt）：

```
[channel] {mission_id}
[worker] {worker-name}
[token] {token}
You are working on: {title}. 先 Read 任务包 {pack_path}，按包内 TASK/RULES 执行；用 mcp__plugin_agent-orchestrator_orch__report 汇报（kind ∈ milestone/blocked/question/done）。Return：做了什么+产物路径+遗留问题。
```

要点：上游上下文必须**逐字物化**进包——子代理"当时不在场"，上下文只在你脑子里，不在它的脑子里。

## 4. 状态→动作决策表

| 观测 | 来源 | 主控动作 |
|---|---|---|
| dispatched，无完成通知 | board | 继续别的活，不轮询 |
| 完成通知到达 | 通知 | 读输出文件路径 → `mailbox(read)` 消费 → 聚合落盘 → mission closed |
| running 且最老事件 age_ms>15min | `mailbox(peek)` | `SendMessage(steer)` 询问进度；无 agentId → 派 scout 查证 |
| kind=blocked/question | `mailbox(read)` | 能答→`mailbox(answer)`+SendMessage；需查证→先派 orch-scout；workflow→`ResolveWorkflowQuestion(dwfq-id)` |
| done | report/board | 聚合 → closed |
| done 且 mission 为沙箱派发（pack.sandbox 存在） | board | 派 orch-reviewer 审 diff+越界 → `board(upsert, mission={id, qa:{verdict,…}})` → pass 则 `sandbox_apply(mission_id)`；fail 则 `sandbox_discard`（第 17 章） |
| ready（无人领取的池任务） | board/resume | 不算未竟不告警；要动它就派池工自领取（第 18 章）或改走普通派发 |
| 疑似唤醒失败（done/failed/blocked/question + dispatch.agent_id 非空 + 未签收） | board / Stop 清单 | `mailbox(read)` 接手结果 → 处置（answer/close 自动签收）；用户要求暂缓 → `board(action="ack", mission_id, note="deferred by user")`；workflow 模式不参与此判定 |
| 哨兵告警（bg-sentinel exit 1 完成通知） | 通知 | 按疑似唤醒失败流程接手未签收项（mailbox(read) → answer/close，自动签收）；处置后可再派一个哨兵继续盯守 |
| done/failed 签收时有候选 lessons | `lessons(list, status="candidate")` | 合格的 `lessons(action="promote", id=…)`（单句原子、不与 AGENTS.md/board 重复）；不合格放任 gc；failed 建议补 `lessons(action="add", type="error-fix", …)` 反思 |
| workflow errored | 通知 | 读错误 → 改 script 文件 → `AmendWorkflow(path)`（勿 CreateWorkflow 重写） |
| workflow stopped=user | 通知 | 除非用户要求，不动 |
| stopped=provider | 通知 | 按 `<error>` 修复 → `ResumeWorkflowRun(run_id)` |
| stopped=interrupted | 通知 | `ResumeWorkflowRun(run_id)` |
| superseded | — | 勿恢复，看 successor |
| Stop 注入清单 | Stop hook | 逐项处置后收工 |
| `TaskOutput` "No task found" | TaskOutput | 用完成通知输出文件路径；或 `GetWorkflowRun`/`ListWorkflowRuns` |

## 5. 提问-回答-恢复闭环

- 常规通道：子代理 `report(kind=blocked|question)` → 事件落邮箱、mission 置 blocked/question → 你 `mailbox(peek)` 发现 → `mailbox(read)` 消费 → **需要查证就先派 orch-scout** → `mailbox(action=answer, mission_id, answer)`（留痕并拿回 `recommended_call`）→ 按建议发 `SendMessage(to=agent_id, summary≤200, message=答复+继续指令)`。运行中=steer 注入；已终态=后台恢复续聊（可反复）。
- 紧急四情形（验收标准要变 / 继续无意义 / 需不可逆操作 / 阻塞超 10 分钟）：子代理直接用内核 `RespondToCoordinator` 唤醒你（仅当你给它发过消息、该工具出现时才有）。你正常作答即可。
- workflow 场景：子代理 `escalate` → 你收到通知与 `dwfq-…` 问题 id → `ResolveWorkflowQuestion(question_id, answer)`。答题期间 run 其余部分照常跑；**dwfq 无超时，不能放着不答**。通知丢失兜底：`GetWorkflowRun` 看 `pendingQuestions`。脚本本身坏了 → 改 script 文件 + `AmendWorkflow(path)`。
- 签收语义：你接手（处理完）一个子代理的结果后，该 mission 会被打上 ack——`mailbox(answer)` 与 close（`board(upsert, status="closed")`）都自动补签。需要"已知悉、暂缓处理"时显式 `board(action="ack", mission_id=…, note="deferred by user")`。终态（done/failed/blocked/question）且未签收的 mission 会在 Stop 清单与 resume 简报中被标为"疑似唤醒失败"。
- lessons 提炼时机：done/failed 的候选 lessons 不在事件 payload 里，用 `lessons(action="list", status="candidate")` 查。签收时顺手处理：合格的 promote（单句原子、不与 AGENTS.md/board 已固化内容重复——复述既有规则的不要晋升），不合格放任 gc；failed 建议补一条 error-fix 反思，与新教训矛盾的旧条目用 `contradicts` 证伪（旧条 superseded 不删除，记反例）。

## 6. 后台并行纪律

- **硬纪律——禁止前台派发长任务**（`run_in_background` 缺省/false 的 Agent 调用）。两个后果：
  ①前台子代理占住主控回合：你被锁死在等待里，无法并行派发、无法响应用户；
  ②用户此时发来任何消息会取消整回合，连带取消前台子代理——已完成进度丢失。
  正确做法：一律 `run_in_background=true`，多条放同一消息即并发。
  插件闸门（userConfig `background_gate`，默认 remind）会对疑似长任务的前台派发放行并注入提醒；=ask 时转为人工确认；子代理类型命中 `background_gate_exempt_types`（默认 judge）时豁免。
- `run_in_background=true` 是默认；多条 Agent 调用放**同一条消息**即并发（上限约 8）。
- 不轮询、靠完成通知。`TaskOutput(task_id, block=true, timeout≤600000)` 仅作显式等待；偶发 "No task found" → 兜底 = 完成通知里的输出文件路径，或 `GetWorkflowRun` / `ListWorkflowRuns`。
- 失控任务收敛：`TaskStop(task_id)`。
- 聚合纪律：全文写文件、只带摘要进上下文——把子代理长文原样读进上下文是上下文膨胀的首因。
- 收工时还有任务在飞？先启动唤醒哨兵再走（见第 14 章）：后台 Bash 运行 `hooks/bg-sentinel.mjs --once`——全部签收它静默自毁（通知无害），超时未签收它告警叫醒你。忘了启动也不慌：未签收任务仍会出现在 Stop 清单与 resume 简报的"疑似唤醒失败"里。

## 7. 恢复手册

- **同会话**（agentId 仍有效）：`SendMessage(to=agent_<uuid>, summary, message)` 恢复终态子代理续聊；workflow 按 stopped 原因决策（见第 4 章表）。
- **workflow**：stopped→`ResumeWorkflowRun(run_id)`；errored→读错误、修 script 文件后 `AmendWorkflow(run_id, path=脚本文件)`（勿 CreateWorkflow 重写）；superseded→看 `superseded_by` 勿恢复；provider 停→按 `<error>` 提示解决后续跑；user 停→除非用户要求不动。
- **跨会话**（agentId 失效）：SessionStart hook 会注入可恢复简报；跑 `/orch-resume` 或 `resume` 工具取得 per-mission `recommended_action`：能 SendMessage 的恢复；不能的用 `context_pack`（original_prompt/pack 都在 board 里）重建上下文 + 同类型角色重新派发——**连续性靠文件，不靠 agentId**。新会话派发时把 session_id 记进 dispatch。近期会话现场由上下文镜像支撑（resume 的 prev_sessions.tail / 第 15 章）；深挖再用 ReadSessionContext。

## 8. 分叉模式

- **2–8 个独立变体、一轮出结果**：`context_pack(variants=N, variant_axes=[...])` → 同一条消息发 N 条 `Agent(run_in_background=true)`（prompt 用返回的 `prompt_templates` 对应项）。适合 A/B 方案、多库调研、多风格实现。
- **需要循环/门禁/结果互联**：用 `CreateWorkflow` 写 fan-out 脚本。workflow 里角色 = persona(system+model)：`agent(name, { system?, model? })` 可按子代理指定模型（未指定继承 run 级 `subagent_model`）；工具面仍全局同一，没有 per-agent 工具集。
- **结果比较**：变体跑完派 orch-reviewer 汇总评审，再向用户给 verdict。

## 9. 模型选择两轨

**普通 Agent 轨**（Agent 工具无 model 参数，三级优先）：
1. 用户显式指定 → 先 `ListModels` 校验 id（`disabledReason` 非空则换）。
2. 角色绑定（一角色一模型）→ `spawn_agent(name="orch-worker-<tag>", model="providerId/modelId")` 造变体角色。
3. 默认继承会话模型。

**workflow 轨**（三种粒度，优先级 persona.model > run 级 subagent_model > 会话模型）：
1. 脚本内 per-agent：`agent(name, { model })` 的 model 取**编译期字符串字面量**（`"modelId"` / `"providerId/modelId"`，可带 `$reasoningLevel` 后缀如 `"GLM-5.3$high"`）或 `model("…")` 返回的 ModelRef。模型声明表放脚本顶部（`const M = { strong: model("…"), fast: model("…") }`），一处 amend 全局生效；运行期只能在已声明 ModelRef 之间选择，agent() 创建时冻结。
2. run 级 `subagent_model`（`CreateWorkflow`/`AmendWorkflow` 设置，`ListModels` 查询；settings-only 改=停旧开新）。
3. 未指定者继承会话模型。

没有"运行中动态改单个子代理模型"的 API。唯一路径 = 改脚本里的模型字面量/表 → `AmendWorkflow(path)`（supersede 旧 run，已完成工作零成本导入为缓存；改某子代理模型不冲掉它的缓存，但缓存命中的已完成 ask 仍返回旧模型结果，仅新 live ask 跑新模型）。启动期校验：脚本中所有模型名对照 host 模型目录解析（modelBindings 记 journal）并经用户确认窗口批准，host 无模型目录则拒绝启动；诊断码 9010=编译期 model 值非法（非字面量/字面量联合/ModelRef、动态拼名，提示 as const），9011=解析失败（not_found/ambiguous/disabled/reasoning_level_unknown，提示 `ListModels` 或改用全 providerId/modelId）。使用纪律：仅当用户要求或明显轻量层（judge/router）时用 per-agent 模型，id 一律取自 `ListModels`。

## 10. 自定义角色

- `spawn_agent(name, description, archetype=worker|scout|reviewer, model?, max_turns?, tools?, system_prompt?, overwrite?)` → 写入 `<项目>/.zcode/agents/<name>.md`。
- 生效时机：**新会话注册**；当前会话要立即用 → `Agent(prompt=原型正文+system_prompt)` 注入 persona 替代。
- 三个 archetype：worker（执行，cyan）/ scout（只读调研，blue）/ reviewer（评审，yellow）；`tools` 覆盖原型工具面时 report 全名强制保留。
- 转正：某个临时代理用得好 → `spawn_agent` 固化成项目角色，下次免注入。

## 11. Stop 提醒处置

收到 Stop hook 注入的收工清单 → 逐项处置：能 close 的 close（聚合产物）、blocked 的答（mailbox answer + SendMessage）、unread 的读。确实收工则处置完再停。`stop_hook_active=true` 时平台即将放行，不要依赖无限提醒——清单一次给全，一次处置完。

清单区分两类计数："未竟"与"疑似唤醒失败"。疑似唤醒失败项**优先处置**：先 `mailbox(read)` 接手，再 answer/close（自动签收），或显式 ack defer。用户明说"先放着"的，务必补 `board(action="ack", note="deferred by user")`——否则每次收工它都会重新出现在疑似名单里。

## 12. 坑位清单

- 不存在 SubagentStop / PreCompact 等 hook 事件（hooks 仅 7 事件）；hook payload 不区分子代理身份。
- Agent 工具**无 model 参数**；普通子代理没有 SendMessage/提问工具（上行 = RespondToCoordinator[需主控先发过消息] 与终态返回）。
- SendMessage summary≤200、message≤20000；`${ARGUMENTS}` 不被命令替换（命令正文用 `$ARGUMENTS`/`$1`）。
- 聚合全文进上下文 = 上下文膨胀首因；子代理互调禁止；单会话并发约 8；SaveWorkflow 需用户同意。
- `ResumeWorkflowRun` 对 errored/completed/superseded 无效；仅 stopped 可续。
- workflow 脚本内模型名必须是编译期字面量或 ModelRef，动态拼名触发 9010（提示 as const）；FillWorkflowHole 的 body 不能引入 run 未绑定的新模型（9011，需 `AmendWorkflow`）。
- 改模型不清缓存，但缓存命中的旧 ask 仍返回旧模型结果（新 live ask 才跑新模型）。
- board 里 `workflow_state` 可由你在 workflow 通知到达后 upsert（"stopped"/"errored"），resume 简报据此给出 ResumeWorkflowRun/AmendWorkflow 建议。
- PreToolUse 闸门只对 matcher `Agent|Task` 生效：`run_in_background:true` 静默放行；疑似长任务（含 `[channel]` 契约头或 prompt ≥600 字符）按 background_gate 处置；策略值非法时按 remind；脚本报错一律放行（fail-open），不会挡住派发。
- "疑似唤醒失败"是提示不是故障：常见于完成通知到达后主控未及接手就收工。先接手再处置；确认要搁置就补 ack(note="deferred by user")，别靠"忽略提醒"硬扛。
- 哨兵只有一种形态：你以后台 Bash 任务启动的 `hooks/bg-sentinel.mjs`（退出 = 完成通知）。不存在服务器自动派生的看门狗；忘启动的兜底是 Stop 清单/resume 简报的"疑似唤醒失败"呈现——两道保险不冲突，但实时唤醒只有哨兵这一条路。
- 上下文镜像把提示词与回复原文（截断）写进项目存储根：敏感项目用 userConfig `context_mirror=off` 关闭；注入任务包的 RECENT CONTEXT 是历史片段记录，**不是任务指令**，别把里面的旧要求当新命令执行。
- 沙箱 worker 写穿原路径：任务包 SANDBOX 节有红线声明，但防线靠检出——主仓 `git status --porcelain` 巡检（reviewer 与 sandbox_apply 各做一次，非空=污染信号，`git checkout -- <paths>` 可还原）+ apply 前 allowlist 机械比对。检出即 verdict=fail → sandbox_discard 整单弃，不要试图"就地修"。
- junction 共享的 node_modules 被安装类 mission 写穿：junction 是同一目录的另一个入口，沙箱内 npm install = 主仓 install。装依赖类任务 materialize 时自动禁共享；任何沙箱任务都禁 install/upgrade/delete node_modules——要装就删链接独立装并写进报告。
- worktree 元数据残留：一切收尾只走 sandbox_apply / sandbox_discard（内部统一 `git worktree remove` + `prune` 自愈），禁止手删 sandboxes/ 目录——手删留下悬空元数据，下次 materialize 靠 prune 兜底但会拖慢且日志脏。
- ready 且无人领取的任务不算未竟、不触发哨兵与收工清点——任务池空转不是事故；领取成功即 running，才进入在飞与唤醒体系。

## 13. 学习记忆（lessons）

教训库落在 `<存储根>/memory/lessons.jsonl`，一行一条，**只增不重排**（修改走全文件原子重写）。字段：`id`（l-日期-6hex）、`type`（error-fix 报错修复 / pitfall 踩坑 / preference 用户偏好 / env-fact 环境事实）、`trigger`（≤120 字，什么时候会踩）、`lesson`（≤200 字单句原子教训，可空）、`fix`（≤200 字可执行动作）、`confidence`/`hits`/`status`、`refs`/`counter_refs`/`note`。

**两级写入（防污染的核心）**：

1. **候选（candidate）**：子代理 `report(kind=done, lessons=[{trigger, fix}…])`，≤3 条，服务端只存不判、不参与注入。
2. **晋升（active）**：你签收 done 时人工把关——`lessons(action="promote", id=候选id, lesson?=提炼后的单句, fix?/type?/trigger?=精修)`。合格的才晋升：**单句原子、不复述 board 状态机语义或 AGENTS.md 已固化内容**；晋升初始 confidence=0.6、hits=1。同 trigger+fix 的 active 已存在 → 自动合并（老条 hits+1、confidence+0.1 上限 0.95），候选置 retired。

**检索与注入**：`lessons(action="list")` 默认 status=active 按 score 降序（score = confidence × (1+ln hits) × e^(-天/30)，30 天半衰）。每次 `context_pack` 按任务标题/任务/read_first 的关键词（ASCII 词 + CJK 2-gram）匹配 trigger+lesson+fix，取交集 ≥1 的前 6 条、总 ≤1200 字注入 LESSONS 节；SessionStart 简报附全局 top3 单行。无匹配 → 不出现。

**矛盾与退役**：新事实推翻旧条 → `lessons(action="add", …, contradicts=<旧id>)`：旧条置 superseded（记 counter_refs 反例，不删除，可审计）。退役三通道：score < 0.1 自动衰汰（任何 lessons 操作入口 housekeep）、`mailbox(gc)` 顺带把过期 candidate 置 retired、`lessons(action="retire", id, reason?)` 手工。

**与镜像的关系**：镜像（第 15 章）是滚动淘汰的临时缓冲；要把对话中的用户偏好/环境事实"钉住"，升级为 lessons（见 15 章用法）。

## 14. 唤醒哨兵（bg-sentinel）

平台事实：只有**后台任务完成通知**能在你空闲时开新回合（忙时并入当前回合，不打断）。哨兵利用这一点：它由你以后台任务启动，**退出 = 通知 = 叫醒你**。没有别的形态——服务器不会自动派生看门狗（detached 进程的退出无通知，叫不了人）。

**启动（固定 ritual，已并入第 2 章第 4 步）**：本回合首次 Agent 派发后，顺手发：

`Bash(command="node <插件根>/hooks/bg-sentinel.mjs --once", run_in_background=true, description="哨兵：未签收任务超时叫醒")`

bg-gate 的派发提醒也会在（哨兵未在岗且过 10 分钟冷却时）附带这句话。超时/重试/间隔默认取 userConfig（wake_timeout_min=10 / wake_retries=3 / wake_poll_sec=60），可 CLI 覆盖（`--wake-timeout-min` 等）。

**退出条件**：
- 无在飞 mission（dispatched/running/resumed）且无未签收终态 → **静默 exit 0 自毁**（"全部已签收"的安静通知，无害）；所以全部处置完后无需手动停它；
- 未签收结果持续跨越 `wake_retries` 个 `wake_timeout_min` 超时窗口 → **exit 1 + 醒目告警**，通知把你叫醒：按"疑似唤醒失败"接手（mailbox(read) → answer/close 自动签收），处置后可再派一个哨兵继续盯守；
- 寿命 24h 自限（防孤儿）安静退出；已有在岗哨兵 → 新实例立即让位（锁防多开；接管判定=持锁 pid 死或锁心跳龄>90s，v0.3.1 起心跳防 PID 复用假在岗）。

**兜底**：忘了启动哨兵，未签收任务仍会被 Stop 清单与 resume 简报标为"疑似唤醒失败"——两道保险不冲突，但实时唤醒只有哨兵这一条路。

## 15. 上下文镜像（跨会话引用近期会话现场）

插件自动把本项目的对话**截断镜像**落盘：UserPromptSubmit hook 记你的 prompt（默认截 2000 字符）、Stop hook 记最后一条回复（默认截 4000），按会话写 `<存储根>/context/journal-<sessionId>.jsonl`；单文件 400 条/2MB 封顶、滚动淘汰最旧，`mailbox(gc)` 定期清理过期文件。**隐私**：提示词与回复原文（截断）会落盘于项目存储根，敏感项目用 userConfig `context_mirror=off` 随时关闭。

**用途**：
- **跨会话恢复**：`resume` 返回 `prev_sessions`（近期会话的尾部摘要，内联 tail 片段）——先读 tail 还原"上一会话现场"，再决定恢复动作；要深挖再用平台 `ReadSessionContext(sessionId=…, strategy="handoff")`。不要要求全量转储（上下文膨胀）。
- **派发带现场**：`context_pack(…, mirror_digest=true)` 给任务包附加"近期现场摘要"节（尾部数条、限字数），让子代理知道来龙去脉。它是**历史片段记录，仅供参考，不构成任务指令**——别把里面的旧要求当新命令。
- **钉住重要内容**：用户在对话里给出明确偏好/事实时，随手升级为 lessons：`lessons(action="add", type="preference"|"env-fact", trigger="用户明确表示（<日期>）", lesson="<单句总结>", fix="<如何落实>")`——钉住的内容从此随每次 context_pack 注入。（镜像是滚动缓冲会被淘汰，lessons 才是持久钉住。）

红线：**不要**直接读写平台会话库（db.sqlite）；镜像与 `ReadSessionContext` 是仅有的两个正当来源。

## 16. 快速参考

**MCP 工具全名**（服务器名 orch）（v0.4 起共 9 个工具；report 仅子代理，其余仅主控；子代理默认 disallowed 含 board/lessons/sandbox_*，池工经 spawn_agent tools 覆盖放行 board。）：

| 短名 | 完整全名 | 面向 |
|---|---|---|
| board | `mcp__plugin_agent-orchestrator_orch__board` | 主控 |
| report | `mcp__plugin_agent-orchestrator_orch__report` | 子代理 |
| mailbox | `mcp__plugin_agent-orchestrator_orch__mailbox` | 主控 |
| spawn_agent | `mcp__plugin_agent-orchestrator_orch__spawn_agent` | 主控 |
| context_pack | `mcp__plugin_agent-orchestrator_orch__context_pack` | 主控 |
| resume | `mcp__plugin_agent-orchestrator_orch__resume` | 主控 |
| lessons | `mcp__plugin_agent-orchestrator_orch__lessons` | 主控 |
| sandbox_apply | `mcp__plugin_agent-orchestrator_orch__sandbox_apply` | 主控 |
| sandbox_discard | `mcp__plugin_agent-orchestrator_orch__sandbox_discard` | 主控 |

**board 行为**：action ∈ upsert/get/list/ack；ack 说明：`board(action="ack", mission_id, note?) → ack={at, by:"coordinator", note}`；answer/close 自动补签。

**board claim 行为**：`board(action="claim", mission_id, worker, lease_minutes?)`——CAS 领取 ready/drafted 任务（owner 置空才可领、依赖全绿才可领），成功即 running 并写租约；worker 每次 report 自动续租；超时自动回 ready。沙箱 apply/discard：门禁=done+qa.verdict=pass；discard 幂等零损伤。

**lessons 行为**：action ∈ list/add/promote/retire；list 默认 status=active 按 score 降序；add 可带 contradicts=<旧id> 记反例；候选由 report(kind=done, lessons=[…]) 产生，`lessons(list, status="candidate")` 查看待提炼。

**镜像与哨兵**：镜像文件 `<存储根>/context/journal-<sessionId>.jsonl`（context_mirror=off 可停写）；哨兵命令 `node <插件根>/hooks/bg-sentinel.mjs --once`（后台 Bash），退出码 0=全清自毁/到期/让位，1=告警。

**kind 枚举**：milestone / blocked / question / done（summary ≤ 200 字；blocked/question 必带 question；done 必带 artifacts）。

**mission 状态机**：`drafted →(解锁 blockedBy 全绿)→ ready →(claim)→ running → (blocked|question|done|failed|skipped)`；`drafted → dispatched → running`（普通派发，不经 ready）；`blocked/question →(answer) dispatched/resumed`；`done/failed → closed`；`skipped 为终态（skippedReason=upstream_failed），复核后 closed 归档`；workflow stopped 标 `resumed` 后继续用 running/done。

**平台编排原语速查**：

- `Agent {description, prompt, subagent_type, run_in_background}`；无 model 参数；同步返回含 `agentId`（agent_<uuid>）；多条放同一消息=并发。
- `SendMessage(to=agent_<uuid>, summary≤200, message≤20000)`：终态=后台恢复续聊（可反复）；运行中=steer。
- `TaskOutput(task_id, block, timeout≤600000)`；`TaskStop(task_id)`。
- workflow：`CreateWorkflow{script|saved|path, name, max_concurrency, subagent_model}`、`AmendWorkflow{run_id, path|script, subagent_model, max_concurrency}`（任何状态可改，旧完成工作导入为缓存）、`ResumeWorkflowRun{run_id}`（仅 stopped）、`GetWorkflowRun`（pendingQuestions）、`ListWorkflowRuns{statuses}`、`ResolveWorkflowQuestion{question_id(dwfq-…), answer}`、`EvalWorkflowSnippet`、`ListModels`、`SaveWorkflow`（需用户同意）。子代理 `escalate` 每 ask 限 3 次。模型：可按子代理在 persona 指定——`agent(name, { system?, model? })`，model 取编译期字面量（可带 `$reasoningLevel`）或 `model("…")` 的 ModelRef，id 取自 `ListModels`；未指定继承 run 级 `subagent_model`；启动期模型名对照 host 模型目录校验并经确认窗口批准；诊断码 9010（编译期 model 值非法）/9011（解析失败，含 fill 引入 run 未绑定的新模型）；工具面仍全局同一、无 per-agent 工具集。
- hooks 仅 7 事件；插件注册 SessionStart（恢复简报）、Stop（镜像记录 + 收工清点，含疑似唤醒失败）、PreToolUse（Agent|Task 后台闸门 + 哨兵派发提醒）、UserPromptSubmit（镜像记录，恒静默）四个；Stop 用 hookSpecificOutput.hookEventName="Stop"+additionalContext；PreToolUse 用 permissionDecision allow/ask + additionalContext；退出码 0 放行。
- userConfig：storage_dir（存储根）、background_gate（remind|ask|off，默认 remind）、background_gate_exempt_types（默认 judge）、wake_sentinel（on|off，默认 on；派发提醒是否附带哨兵提示）、wake_timeout_min（默认 10）、wake_retries（默认 3）、wake_poll_sec（默认 60）、context_mirror（on|off，默认 on；off 停止落盘镜像）、context_mirror_max_chars（默认 "2000,4000"）、sandbox_default（none|worktree，默认 none；context_pack 未显式传 isolation 时的默认值）、claim_lease_min（默认 30，最小 1；board claim 自领取租约分钟数）。

## 17. 沙箱派发（sandbox_dispatch）

**适用判据（三条全满足才用）**：任务是改代码；改动可被 git diff 表达；项目本身是 git 仓库（有提交）。调研/文档类任务用普通派发即可；非 git 项目 context_pack 会直接拒绝并引导 git init（不做 copy 降级）。

**七步沙箱变体**：

1. `context_pack(mission_id, title, task, read_first, rules, isolation:"worktree", oob_allowlist:["src/","tests/"])`——materialize 一步建 worktree 沙箱：分支 `orch/<mission_id>`、`<存储根>/sandboxes/<mission_id>/` 工作区、任务包内项目路径前缀改写为沙箱路径并附 SANDBOX 节（红线声明+done 必附 diff 存证）。`share_node_modules` 缺省自动：主仓有 node_modules 且任务不像安装类 → junction 共享（只读使用）；装依赖类任务自动禁共享。
2. 正常派发（Agent run_in_background=true + 三行契约）——worker 在沙箱内干活，原仓路径只读。
3. `report(kind=done, artifacts=[diff-stat 文件, diff-name-list 文件])` → board 置 done。
4. 派 orch-reviewer 审 diff：`git diff --name-only <base_commit>` 逐路径比对 allowlist + `git -C <项目> status --porcelain` 巡检主仓污染。
5. 评审 mission done → 主控把 verdict 抄录到目标 mission：`board(upsert, mission={id:"<目标>", qa:{verdict:"pass", by:"orch-reviewer", mission_id:"<评审id>", note:"…"}})`。
6. verdict=pass → `sandbox_apply(mission_id)`：主仓巡检 → 越界机械检出 → `merge-tree` 冲突预检 → 干净 merge（--no-ff）→ worktree remove → board closed + 自动签收。
7. verdict=fail（或越界/污染）→ `sandbox_discard(mission_id)`：弃分支+删 worktree，主仓零改动，按需重派。

**门禁时序图**：

```
context_pack(isolation="worktree")            # materialize：分支+worktree+路径改写
  → worker 在沙箱内干活（原仓路径只读红线；junction 只读）
  → report(kind=done, artifacts 含 diff-stat/diff-name-list)   # board 置 done
  → 主控派 orch-reviewer 审 diff + 越界（allowlist 比对 + 主仓 porcelain 巡检）
  → 评审 mission done → 主控 board(upsert, mission={id:<目标>, qa:{verdict:"pass",…}})
       ├─ verdict pass  → sandbox_apply(mission_id) ─ 成功：merge+commit+worktree remove+board closed+自动 ack
       │                                              └ 冲突：isError+冲突清单 → 派合并代理（四件套）→ 复审 → 再 apply
       └─ verdict fail  → sandbox_discard(mission_id)（弃分支+remove，零损伤）→ 按需重派
```

**冲突分支**：apply 报 `合并存在冲突` 时主仓未被触碰（board 不动、工作树不触）。按 isError 里的指引派合并代理：`context_pack(mission_id=<新id>, task="把 <branch> 合入主线并解决冲突", isolation="worktree", read_first=[四件套文件…])`——四件套 = merge-base（`git merge-base HEAD <branch>`）+ 主线侧 diff（`git diff <merge-base>..HEAD`）+ 分支侧 diff（`git diff <merge-base>..<branch>`）+ 冲突文件两侧内容（`git show <rev>:<path>`）。解决后复审再 apply。万一 apply 中途死在 merge 之后 board 之前：重入幂等（applied_at 存在即补偿 close）；主仓侧可 `git reset --hard ORIG_HEAD` 人工回退。

**三层检出矩阵**：

| 层 | 时机 | 手段 | 检出后果 |
|---|---|---|---|
| 包内红线 | 派发时 | SANDBOX 节红线声明 | 预防 |
| reviewer 审查 | done 后 | 人工/代理审 `diff --name-only` vs allowlist；`git -C <项目> status --porcelain` 巡检 | verdict=fail → discard |
| apply 机械门禁 | apply 时 | porcelain + allowlist 两道 | isError 拒绝，零副作用 |

**承诺**：apply 失败零副作用（board 不动、主仓不触）；discard 零损伤（主仓字节级不变）；主仓永远干净——任何沙箱 mission 的收尾都从这两条工具走，不要手工 merge/删目录。qa 门禁没有逃生门（allow_dirty 只豁免主仓巡检一项）；主仓 `git reset --hard ORIG_HEAD` 是 apply 后人工回退的最后一道闸。

**沙箱三条风险**（与第 12 章呼应）：worker 写穿原路径（防线靠检出，检出即整单弃，不要"就地修"）；junction 被安装类 mission 写穿（装依赖类自动禁共享，任何沙箱任务禁 install/upgrade/delete node_modules）；worktree 元数据残留（收尾只走 apply/discard，禁止手删 sandboxes/ 目录）。

## 18. 任务依赖与自领取

**字段速览**：`blockedBy`（上游 mission_id 数组，DAG 入边，可经 upsert 写，允许前向引用）；`owner`（当前领取者，只读，由 claim 维护）；`claim`（{worker, token, claimedAt, leaseUntil} 租约，只读）；`skippedReason`（skipped 终态原因，当前仅 upstream_failed）。

**解锁/级联语义**：`blockedBy` 全部 done/skipped/closed → drafted 自动解锁为 ready（**closed 算满足**=处置完成态）；任一上游 failed/skipped → drafted/ready 级联为 skipped（skippedReason=upstream_failed，**skipped 算失败信号不是满足**——下游要么一并 skip，要么修订 blockedBy 重规划）。扫描在每次 board 写事务内 fixpoint 执行（done 事务同步解锁/级联），链式失败一次扫清；成环的 blockedBy 变更直接拒绝（依赖必须是 DAG）；悬挂引用（指向不存在的 mission）在扫描时自动清理。

**claim CAS 与租约**：`board(action="claim", mission_id, worker, lease_minutes?)`——owner 为空且状态 drafted/ready 且依赖全绿才可领；成功即 running 并写 {worker, token, claimedAt, leaseUntil}（token 缺失时补发）。worker 每次 report 自动续租（缺省租约取 userConfig `claim_lease_min`=30）；超时未续自动回 ready 可再领取（下一个写路径顺带回收，无需定时器）。两个池工抢同一任务，根锁内 CAS 恰一人成功，另一人 isError 附当前 owner。

**池工模式**（同构任务池才需要，普通派发用不上）：主控显式 spawn 一个放行 board 的角色——`spawn_agent(name="orch-pool-<tag>", archetype="worker", tools=["report", "mcp__plugin_agent-orchestrator_orch__board"], system_prompt="你是池工：循环 claim→干活→report→再 claim，直到 claim 全部失败（无 ready）后正常结束；不要 upsert/ack，那两件事归主控")`——当前会话立即用则 `Agent(prompt=原型正文+system_prompt)` 注入。池工 claim 成功后按 next_hint：先 Read 任务包按 TASK/RULES 执行；期间每完成一步 report（自动续租）；完成后 report(kind=done)。

**口径（逐字）**：ready 且无人领取的任务不算未竟、不触发哨兵与收工清点——任务池空转不是事故；领取成功即 running，才进入在飞与唤醒体系。

## 19. 主控并行迭代规程（多轮流水线）

长任务（多步改造、持续集成式开发）不要串行等待：把"调研→设计→实现→QA/评审"拆成迭代，让多轮同时在飞。

**流水线规则（核心判据——输入冻结才准开工）**：第 N+1 轮的调研/设计可以在第 N 轮进入 QA/评审时启动，前提是 N+1 的输入已经冻结。冻结判据（全部满足才算）：
- 输入是已落盘的文件/文档（不是"我一会儿再改的想法"）；
- 与上一轮的交集只有"上一轮的产出作为只读上游"——上一轮评审若打回，改动面不波及本轮已开工部分，或波及时本轮尚在读上游阶段（便宜重做）；
- 本轮 mission 的任务包已用 context_pack 物化（上游产物逐字进包）。
拿不准就别并发：串行一条链也是合法规程。

**并发上限**：同时在飞的 mission ≤ 8（平台单会话并发约 8 的硬约束）。迭代任务排队，完成的签收一个、放出下一个。

**mission 与哨兵**：每次迭代 = 独立 mission（独立 pack/独立 token/独立 artifacts），禁止多轮共用一个 mission。唤醒哨兵全项目只一份（锁防多开）：启动一次即可覆盖所有迭代的 mission——每轮新派发自动纳入盯守，不需要每轮各拉一个哨兵。

**聚合纪律**：每轮产出**全文落盘**（写进存储根下的文件，路径记进 mission artifacts），你只把 ≤200 字摘要带进上下文。下一轮的上游上下文用文件路径（read_first）引用，不要把上一轮全文粘进任务包——上下文膨胀的第一杀手就是把子代理长文原样读回主控。

**多迭代同转时的签收与恢复**：
- 签收按 mission 粒度：哪个轮次的结果到了就处理哪个，`mailbox(read, mission_id=…)` 定向消费；其余轮次不受影响。
- done 后先评审（QA mission）再 close；配合沙箱派发时按第 17 章走 qa → sandbox_apply/discard。
- 哨兵告警/疑似唤醒失败只针对具体 mission，处置它不阻塞其余迭代。
- 会话中断后：resume 简报按 mission 列出全部在转迭代与 recommended_action，逐项恢复即可——连续性靠 board+文件，不靠记忆。
- 迭代编号进 title（如「v2 迭代：搜索重构——实现」），Stop 清单与简报里才扫得清轮次。
