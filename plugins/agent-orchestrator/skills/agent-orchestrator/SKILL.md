---
name: agent-orchestrator
description: "主控操作手册：把主控 agent 变成任务指挥官。当需要（a）派发/并行/分叉多个子代理并持续跟踪；（b）子代理后台跑、主控同时继续别的活；（c）子代理阻塞提问、主控作答后让它继续；（d）同会话或跨会话恢复中断的任务；（e）给不同子代理/角色选不同模型；（f）运行时创建自定义角色；（g）沉淀与复用编排教训（lessons）；（h）任务完成未签收时被哨兵家族叫醒（防完成通知丢失）；（i）跨会话引用近期会话现场（上下文镜像）；（j）把写代码任务隔离进 git worktree 沙箱并安全合并；（k）任务依赖编排与池工自领取；（l）多轮迭代流水线并行推进；（m）控制派发成本——文件所有权分区、分叉缓存经济、上下文预算与探针纪律——任一情况都使用本技能。含三行契约派发、任务板与邮箱轮询、SendMessage 恢复与 steer、ResumeWorkflowRun/AmendWorkflow、含结果签收与疑似唤醒失败检测、前台派发后台闸门、lessons 经验沉淀、哨兵家族（错峰冗余补枪）与上下文镜像。Stop 收工提醒处置。"
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
- **教训库（memory/lessons.jsonl）**：两级写入的编排/过程教训（MCP 工具 lessons 检索与晋升）。**唤醒哨兵（hooks/bg-sentinel.mjs）**：你以后台任务启动，退出即通知——常态全清转待命（0 通知）、告警才叫醒你。**上下文镜像（context/journal-*.jsonl）**：提示词与回复的截断落盘记录，支撑跨会话现场引用。

## 2. 标准派发七步

1. `board(action=upsert, mission={title, original_prompt, agent_type, status:"drafted"})` 建 mission——**original_prompt 必填**（跨会话恢复的种子）。
2. `context_pack(mission_id, title, task, read_first, rules, upstream_context)` 生成任务包 + token + prompt_template。
3. 派发（宿主快照缺陷期间一律走第 10 章主形态：`Agent(description, prompt=<agents/<role>.md 原型正文> + prompt_template + 任务要点, run_in_background=true)`；typed 形态 `subagent_type="agent-orchestrator:orch-worker"` 恒拒，待宿主修复快照数据源后恢复）。
4. `board(upsert, mission={id, status:"running", dispatch={mode:"agent", agent_id, task_id, session_id, run_in_background:true}})` 记录派发；**并（本回合首次派发时）后台连发 3 次拉起哨兵家族**：`Bash(command="node <插件根>/hooks/bg-sentinel.mjs --once", run_in_background=true, description="哨兵：未签收任务分级叫醒")`——常态全清它们转待命（0 通知），未签收会分级告警叫醒你（family/grace 默认取 userConfig；详见第 14 章）。
5. **不等**：继续干别的活。同一消息里放多条 Agent 调用 = 并发（上限约 8）。
6. 完成通知到达后：读通知里的输出文件路径（兜底）→ `mailbox(action=read)` 消费事件。
7. 聚合落盘（结果写文件，只把摘要带进上下文）→ `board(upsert, mission={id, status:"closed", close_confirmed:true})`（直写 closed 须带一次性瞬态键 `close_confirmed:true`，缺省 ToolError——见第 16 章双门）。（close 会自动补签收 ack；done 附带的候选 lessons 在此时 `lessons(action="promote")` 提炼晋升或放任 gc；本回合全部处置完且哨兵在值守，它会自动转待命，无需手动停）

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
kind ∈ {milestone, blocked, question, done}；summary ≤ 200 字；done 必带 artifacts 路径（软约束：server 不做缺失校验，缺省按空数组收）。

## REPORT（双通道）（可选节：宿主快照缺陷期间的 GP+persona 派发建议保留；typed 恢复后可省略）
- 主通道：`mcp__plugin_agent-orchestrator_orch__report`（kind ∈ milestone/blocked/question/done）
- 降级通道：report 工具不在工具面时，终态回复行首标注 `KIND=xxx`（仅终态、无 milestone 与哨兵联动——中途进度丢失属预期）

## CONTEXT（上游产物，逐字注入——你当时不在场）
{upstream_context 或 "（无）"}

### ENV FACTS（环境事实，主控掌握的运行环境知识——缺了会瞎找，逐条给实测结论）
- CLI/工具可用性：{如 "zcode CLI 在本机不可用，勿尝试；用 node <脚本> 代替" 或 "全部可用"}
- 脚本/驱动路径：{绝对路径 + 调用方式，如验收驱动、harness、一次性脚本}
- 转义与调用坑：{如 "Windows 下驱动参数禁反斜杠路径；JSON 参数单引号包裹"}
- 平台红线：{只读目录/禁写区/DB 访问限制；无则写 "无特殊红线"}

（ENV FACTS 子节必备，四条缺项写"无"，不得整节省略；worker 按 ENV FACTS 行事，与其实测矛盾时 report(question) 而非自行试错；主控只写本轮实测过的结论，重派时重验）

（SUMMARY 为 server 自动生成节：inputs 派发时出现，主控手写包无此节）

## READ FIRST
- {path1}
- {path2}

## TASK
{task}

## RULES
- 只在本包范围内工作，不改包外文件
- 受阻/目标矛盾/必败门禁：立即 report(kind=blocked, question=…)，不硬扛不造假
- {rules...}

## OWNERSHIP（文件所有权）
（仅 scope_paths 非空时出现，缺省整节省略）
允许写（scope_paths，越界 = 验收 fail 信号）：
- {scope_paths 逐条}
清单外路径一律只读。done 的 files_touched 会按此清单比对。

## BUDGET（预算档位）
（仅给定 budget 参数时出现，缺省整节省略）
档位：{S|M|L}（≈{20|60|120} 步上限）。milestone report 请附进度与剩余步数估计；逼近上限时主动收尾：完成当前阶段、report(done) 附遗留清单。
上下文档位：WARN 120K 提醒 / ACT 150K 决策 / HARD 180K 强制收尾 / ABS 230K 红线（由主控对账判定，worker 无需自测）

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
| ACT 且 timeline 已有浓缩事件 | board/timeline | 只剩拆分/放弃，禁二次浓缩 |
| 逼近硬阈值（步数近档位上限，或采样近 HARD 180K） | milestone 对账 / `agent_harvest(tail=0)` | `SendMessage(steer)`："完成当前阶段、report(done) 附遗留清单"，剩余工作按 files_touched 拆新 mission（§20.3） |
| kind=blocked/question | `mailbox(read)` | 能答→`mailbox(answer)`+SendMessage；需查证→先派 orch-scout；workflow→`ResolveWorkflowQuestion(dwfq-id)` |
| done | report/board | 读 t1_head（≤160 字）与产物路径列表；勿 read details 长文 → 聚合 → closed |
| done 且 mission 为沙箱派发（pack.sandbox 存在） | board | 派 orch-reviewer 审 diff+越界 → `board(upsert, mission={id, qa:{verdict,…}})` → pass 则 `sandbox_apply(mission_id)`；fail 则 `sandbox_discard`（第 17 章） |
| done 且任务登记过写集（RULES 清单或 scope_paths） | board/pack | 审计产物 diff（或 files_touched）⊆ 写集；越界 → 追问 worker 或 verdict=fail |
| ready（无人领取的池任务） | board/resume | 不算未竟不告警；要动它就派池工自领取（第 18 章）或改走普通派发 |
| 疑似唤醒失败（done/failed/blocked/question + dispatch.agent_id 非空 + 未签收） | board / Stop 清单 | `mailbox(read)` 接手结果 → 处置（answer/close 自动签收）；用户要求暂缓 → `board(action="ack", mission_id, note="deferred by user")`；workflow 模式不参与此判定 |
| 哨兵告警（bg-sentinel exit 1 完成通知） | 通知 | 按疑似唤醒失败流程接手未签收项（mailbox(read) → answer/close，自动签收）；**处置后补员**——再发 1 次同命令 `Bash(command="node <插件根>/hooks/bg-sentinel.mjs --once", run_in_background=true)` 把家族补满 |
| done/failed 签收时有候选 lessons | `lessons(list, status="candidate")` | 合格的 `lessons(action="promote", id=…)`（单句原子、不与 AGENTS.md/board 重复）；不合格放任 gc；failed 建议补 `lessons(action="add", type="error-fix", …)` 反思 |
| workflow errored | 通知 | 读错误 → 改 script 文件 → `AmendWorkflow(path)`（勿 CreateWorkflow 重写） |
| workflow stopped=user | 通知 | 除非用户要求，不动 |
| stopped=provider | 通知 | 按 `<error>` 修复 → `ResumeWorkflowRun(run_id)` |
| stopped=interrupted | 通知 | `ResumeWorkflowRun(run_id)` |
| superseded | — | 勿恢复，看 successor |
| Stop 注入清单 | Stop hook | 逐项处置后收工 |
| `TaskOutput` "No task found" | TaskOutput | 用完成通知输出文件路径；或 `GetWorkflowRun`/`ListWorkflowRuns` |
| Agent typed 派发返 "Required MCP tool is not available in the parent startup snapshot" | 派发报错 | 确定性失败勿重试；立即回退 GP+persona 注入（第 10 章主形态）+ 任务包附 REPORT 双通道节（第 3 章） |

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
- 收工时还有任务在飞？先启动哨兵家族再走（见第 14 章）：后台 Bash 同命令连发 3 次运行 `hooks/bg-sentinel.mjs --once`——全部签收它们转待命（常态 0 通知），未签收分级告警叫醒你。忘了启动也不慌：未签收任务仍会出现在 Stop 清单与 resume 简报的"疑似唤醒失败"里。

守闸门纪律矩阵见第 20 章（单一事实源，此处不复制）。

## 7. 恢复手册

- **同会话**（agentId 仍有效）：`SendMessage(to=agent_<uuid>, summary, message)` 恢复终态子代理续聊；workflow 按 stopped 原因决策（见第 4 章表）。
- **workflow**：stopped→`ResumeWorkflowRun(run_id)`；errored→读错误、修 script 文件后 `AmendWorkflow(run_id, path=脚本文件)`（勿 CreateWorkflow 重写）；superseded→看 `superseded_by` 勿恢复；provider 停→按 `<error>` 提示解决后续跑；user 停→除非用户要求不动。
- **跨会话**（agentId 失效）：SessionStart hook 会注入可恢复简报；跑 `/orch-resume` 或 `resume` 工具取得 per-mission `recommended_action`：能 SendMessage 的恢复；不能的用 `context_pack`（original_prompt/pack 都在 board 里）重建上下文 + 同类型角色重新派发——**连续性靠文件，不靠 agentId**。新会话派发时把 session_id 记进 dispatch。近期会话现场由上下文镜像支撑（resume 的 prev_sessions.tail / 第 15 章）；深挖再用 ReadSessionContext。

## 8. 分叉模式

- **2–8 个独立变体、一轮出结果**：`context_pack(variants=N, variant_axes=[...])` → 同一条消息发 N 条 `Agent(run_in_background=true)`（prompt 用返回的 `prompt_templates` 对应项）。适合 A/B 方案、多库调研、多风格实现。
- **需要循环/门禁/结果互联**：用 `CreateWorkflow` 写 fan-out 脚本。workflow 里角色 = persona(system+model)：`agent(name, { system?, model? })` 可按子代理指定模型（未指定继承 run 级 `subagent_model`）；工具面仍全局同一，没有 per-agent 工具集。
- **结果比较**：变体跑完派 orch-reviewer 汇总评审，再向用户给 verdict。

**缓存语义选型（先血缘后冷启）**：SendMessage 续聊终态代理 = 原对话保留、只付增量（多轮修正首选）；同 workflow 命名代理 = journal 重放免费（Amend 零成本导入已完成工作）；独立派发 = 冷启全自费。变体分叉（variants）的理由是对比不是省钱——跨任务前缀缓存不可依赖。重新派发前先问："它的上下文还在吗？"

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

## 10. 自定义角色与主派发形态

**主派发形态 = GP + persona 注入**（宿主快照缺陷存在期间所有插件角色派发一律用它）：宿主 typed 校验读取 create 时点冻结的 MCP 启动快照，快照为空期间 `subagent_type` 派发插件角色在 spawn 前恒拒（"Required MCP tool is not available in the parent startup snapshot"），重试无新信息。协议：Read `plugins/agent-orchestrator/agents/<role>.md` 原型正文 → `Agent(description, prompt=<原型正文> + system_prompt + 三行契约头 + 任务要点, run_in_background=true)`；上报走双通道（`mcp__plugin_agent-orchestrator_orch__report` 为主，TOOL_ABSENT 时终态回复行首 `KIND=xxx` 降级；降级通道仅终态、无 milestone 与哨兵联动，中途进度丢失属预期）。GP 形态不经快照收敛路径，是当前**唯一**同时保全 milestone 事件、哨兵联动、manifest/inputs 牵引与板面时间线的形态——typed 派发当前根本无法启动。角色文件 frontmatter 的 tools 清单在该路径下不生效，正文即角色；宿主升级后跑一次最小 GP 探针（任务=调用 report 回显）复核该面未变。**原生 typed 派发的恢复条件：宿主修复快照数据源之后**（判据：`subagent_type` 派发不再报快照缺工具）；原生角色 `tools` 清单 report 全名**保留不删**——删了修复后必断运行时，留着在当前被拒现状下零额外成本。

- `spawn_agent(name, description, archetype=worker|scout|reviewer, model?, max_turns?, tools?, system_prompt?, overwrite?)` → 写入 `<项目>/.zcode/agents/<name>.md`。生效时机：**新会话注册**；且产物走同一子代理装配链，`tools` 覆盖含 `mcp__plugin…` 具体名的在 typed 形态下同受快照收敛——注册≠当下可派发，仍按 GP+persona 注入派发。
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
- PreToolUse 闸门只对 matcher `Agent|Task` 生效：`run_in_background:true` 静默放行；疑似长任务（含 `[channel]` 契约头或 prompt ≥600 字符）按 background_gate 处置；策略值非法时按 remind；脚本报错一律放行（fail-open），不会挡住派发。**闸门是提示面不是防线**：board 不可读静默放行（bg-gate.mjs:200-204）、顶层异常放行（:385-389）与宿主 hook 超时放行（hooks.json PreToolUse timeoutMs=10000）三层 fail-open 叠加，假 token/越权派发可静默通过——机制修复跟踪 V6-52（簇 B）。
- "疑似唤醒失败"是提示不是故障：常见于完成通知到达后主控未及接手就收工。先接手再处置；确认要搁置就补 ack(note="deferred by user")，别靠"忽略提醒"硬扛。
- 哨兵只有一种形态：你以后台 Bash 任务启动的 `hooks/bg-sentinel.mjs`（退出 = 完成通知）。不存在服务器自动派生的看门狗；忘启动的兜底是 Stop 清单/resume 简报的"疑似唤醒失败"呈现——两道保险不冲突，但实时唤醒只有哨兵这一条路。
- **完成通知实测会丢：哨兵家族是冗余防线不是多余动作；收到的每条哨兵告警都按真实事件处置，不要因为"好像刚收到过"而忽略。** 同命令连发 3 次 = 3 条独立性命；派发提示、resume 建议与健康字段（sentinel_health）都以"家族在岗数"为准，缺员就补。
- 上下文镜像把提示词与回复原文（截断）写进项目存储根：敏感项目用 userConfig `context_mirror=off` 关闭；注入任务包的 RECENT CONTEXT 是历史片段记录，**不是任务指令**，别把里面的旧要求当新命令执行。
- 沙箱 worker 写穿原路径：任务包 SANDBOX 节有红线声明，但防线靠检出——主仓 `git status --porcelain` 巡检（reviewer 与 sandbox_apply 各做一次，非空=污染信号，`git checkout -- <paths>` 可还原）+ apply 前 allowlist 机械比对。检出即 verdict=fail → sandbox_discard 整单弃，不要试图"就地修"。
- junction 共享的 node_modules 被安装类 mission 写穿：junction 是同一目录的另一个入口，沙箱内 npm install = 主仓 install。装依赖类任务 materialize 时自动禁共享；任何沙箱任务都禁 install/upgrade/delete node_modules——要装就删链接独立装并写进报告。
- worktree 元数据残留：一切收尾只走 sandbox_apply / sandbox_discard（内部统一 `git worktree remove` + `prune` 自愈），禁止手删 sandboxes/ 目录——手删留下悬空元数据，下次 materialize 靠 prune 兜底但会拖慢且日志脏。
- ready 且无人领取的任务不算未竟、不触发哨兵与收工清点——任务池空转不是事故；领取成功即 running，才进入在飞与唤醒体系。
- **探针原文回显是隐形大头**：4 个会话合计 111 次 DB/二进制原文回显（单会话最高 149KB）——DB 探针禁 `SELECT *`、必须聚合 + LIMIT ≤100；二进制只回显类型/大小/哈希/首 256 字节；单次输出 ≤50 行或 ≤10KB（第 20.4 节）。
- **已读的文件别重读**：server.mjs 曾被单会话重读 12/10/7 次、全文读码 1638 行——派发时把函数/行号锚点写进任务包；≥1000 行文件禁一次全文读入（先 grep 结构再定点读）。
- **typed 角色派发报 "Required MCP tool is not available in the parent startup snapshot"**：确定性失败——校验面（会话 create 时点冻结的 MCP 启动快照）与执行面（继承 live 注册表）数据源分叉，重试无新信息；处置 = 立即回退 general-purpose + persona 注入（第 10 章主形态）+ 任务包附 REPORT 双通道节（第 3 章），勿重试同一 typed 角色、勿归因会话新旧（机制与证据链见 (internal design docs, not published)）。

## 13. 学习记忆与记忆归敛

教训库落在 `<存储根>/memory/lessons.jsonl`，一行一条，**只增不重排**（修改走全文件原子重写）。字段：`id`（l-日期-6hex）、`type`（error-fix 报错修复 / pitfall 踩坑 / preference 用户偏好 / env-fact 环境事实）、`trigger`（≤120 字，什么时候会踩）、`lesson`（≤200 字单句原子教训，可空）、`fix`（≤200 字可执行动作）、`confidence`/`hits`/`status`、`scope`（"project"/"global"，由写入目标库隐含，非调用参数）、`source`（"report"/"add"/"stage"，按写入路径自动标注）、`refs`/`counter_refs`/`note`。

**scope 双级库（v0.8）**：项目库 = `<存储根>/memory/lessons.jsonl`；全端库 = `<~/.zcode>/orchestrator-memory/memory/lessons.jsonl`（server 参数 `--memory-root` 覆盖全端根；落位图权威 (internal design docs, not published) §2.2）。检索注入已是**双库合并选材**（同 normKey 条目全端优先去重，跨项目稳定的教训自动生效）；全端库写面（跨项目晋升 `promote` target="global"）由归敛通道启用（第 22 章）。

**两级写入（防污染的核心）**：

1. **候选（candidate）**：子代理 `report(kind=done, lessons=[{trigger, fix}…])`，≤3 条，服务端只存不判、不参与注入。
2. **晋升（active）**：你签收 done 时人工把关——`lessons(action="promote", id=候选id, lesson?=提炼后的单句, fix?/type?/trigger?=精修)`。合格的才晋升：**单句原子、不复述 board 状态机语义或 AGENTS.md 已固化内容**；晋升初始 confidence=0.6、hits=1。同 trigger+fix 的 active 已存在 → 自动合并（老条 hits+1、confidence+0.1 上限 0.95），候选置 retired。

**检索与注入**：`lessons(action="list")` 默认 status=active 按 score 降序（score = confidence × (1+ln hits) × e^(-天/30)，30 为衰减时间常数、真半衰约 21 天）。每次 `context_pack` 按任务标题/任务/read_first 的关键词（ASCII 词 + CJK 2-gram）匹配 trigger+lesson+fix，取交集 ≥1 的条目：type 加权排序（error-fix 1.0 > pitfall 0.9 > env-fact 0.8 > preference 0.7——**加权只重排，error-fix 命中项永不因权重被滤除**）、score 低于注入阈值 `INJECT_MIN_SCORE=0.40` 的不健康条目才滤除；入选的前 6 条、总 ≤1200 字注入 LESSONS 节，**注入行自带 id**（形如 `- [error-fix·l-20261020-1a2b3c] 触发：…`，供 blocked 回引与归敛溯源）；SessionStart 简报附全局 top3 单行。无匹配 → 不出现。

**随手记（ORCHTEMP，v0.8）**：主控对话中想到值得留、但不值得当下打断流程归类的经验 → `lessons(action="stage", trigger, fix, lesson?, mission_id?, note?)`：落 candidate（source="orchestrator"、confidence=0）、不合并不注入、不占两道帽，由归敛代理（第 22 章）定期拾走落视图层——「随手记，归敛会拾走」。note 可作摆放提示（如 "pin: AGENTS.md"）。

**blocked 回引（v0.8）**：worker 在 blocked/question 报告可附 `lesson_refs=[<教训id>…]` 回引误导它的教训：对应条目 confidence −0.1（下限 0.1）并记 counter_refs（含回引 mission）；触底且被 ≥2 个 mission 回引 → housekeep 自动置 retired。不带该字段的报告行为零变化。

**矛盾与退役**：新事实推翻旧条 → `lessons(action="add", …, contradicts=<旧id>)`：旧条置 superseded（记 counter_refs 反例，不删除，可审计）。退役三通道：score < 0.1 自动衰汰（任何 lessons 操作入口 housekeep）、`mailbox(gc)` 顺带把过期 candidate 置 retired、`lessons(action="retire", id, reason?)` 手工。

**与镜像的关系**：镜像（第 15 章）是滚动淘汰的临时缓冲；要把对话中的用户偏好/环境事实"钉住"，升级为 lessons（见 15 章用法）。教训库的整理维护（视图层归敛、门槛与锁、归敛报告）见第 22 章。

## 14. 唤醒哨兵家族（bg-sentinel v2）

**平台原理（为什么是家族）**：只有**后台任务退出**产生的完成通知能叫醒你；**运行中的任务不产生任何通知，且完成通知实测会丢**。一次进程退出 = 一次通知 = 一枪，单进程只有一条命——多枪冗余在平台事实下唯一的实现形态就是**多实例并存**。哨兵 v2 = N 个（默认 3）互相独立的直至型实例：60s 判定、全清转待命（不退出，见下）；每个实例开一枪（exit 1 通知）后光荣退役，**其余实例继续值守**（开枪不再终止盯守）。

**启动（固定 ritual，已并入第 2 章第 4 步）**：本回合首次 Agent 派发后，同一条消息**连发 3 次**（同命令重复发，自动认领不同槽位）：

`Bash(command="node <插件根>/hooks/bg-sentinel.mjs --once", run_in_background=true, description="哨兵：未签收任务分级叫醒")`

`--once` 接受并忽略（旧版肌肉记忆兼容）。bg-gate 的派发提醒也会在（家族缺员且过 10 分钟冷却时）附带这句话。参数默认取 userConfig（sentinel_family=3 / sentinel_grace_min=5 / wake_poll_sec=60），可 CLI 覆盖（`--wake-grace-min`、`--family-size` 等）。**桥接注记（V7-05 起桥接可达；CONFLICT-1 存根状态终结）**：wake_timeout_min/wake_retries 为桥接键——server 仅显式传参才写 cfg（numArgOpt 稀疏语义，未传则键省略），哨兵按 CLI > cfg 直读键 > 桥接键 > 内建默认解析（bg-sentinel `numArgBridge`），此二键在未传对应 CLI 旗标时分别生效为**两枪最小间隔**/单条件封顶枪数；全不传时哨兵用内建默认 5/3（与历史数值零漂移，CFG-05 默认值漂移锁在案）。

**分级告警阈值**（宽限满 + 双空闲门才叫；逃逸口 2×宽限保证最坏延迟有界，门只推迟不取消）：

| 条件 | 宽限（首枪） | 说明 |
|---|---|---|
| done/failed 未签收 | 5 分钟 | 结果落盘主控未签收 |
| blocked/question 未答 | 3 分钟 | worker 停车等答案，白等最贵 |
| 在飞失联 | 30 分钟 | timeline 无事件（worker 任何 report 续期） |
| 崩溃实锤 | 10 分钟 | rollout 心跳停更 + tool_usage 无 running 行佐证；绕过双空闲门 |
| 板不可读 | 立即 | 连续 3 tick，cap=2 |

**退出与待命（v0.5.1 待命制：常态 0 通知）**：
- **全清 → 实例不退出**（全部签收且无在飞；含仅剩 workflow 在飞——workflow 由宿主完成通知，无需盯守）：槽位写 `state=standby` 转低频待命（板面复核默认 `max(wake_poll_sec, 300s)`，CLI `--standby-poll-sec` / cfg `standby_poll_sec` 可调；心跳照常刷新，bg-gate 与 `sentinel_health` 仍视其在岗——补员提醒天然抑制）。板面出现新在飞/未签收 → 自动复活回 active 正常值守；待命期板不可读静默续待命（不告警）。
- **告警完全照旧**：分级阈值、双空闲门、逃逸口、cap 3 枪、abandoned 回声 + toast 全部不变（exit 1 该醒就醒）。
- **寿命轮换（每寿命周期至多 1 条通知）**：实例到期（默认 24h）做单赢家选举——赢家写 `sentinel/family-teardown.json` 后 exit 0 退出（这条通知表示"本轮轮换完成"，无需处置），输家见新鲜标记自动顺延进入下一轮；家族逐轮递减直至消亡（会话结束后最多残留至各实例最后一轮，长驻是预期）。收到轮换通知可选择性补员（后台重发 3 次同命令），不补也行。
- **补员纪律**：收到告警 → 按"疑似唤醒失败"接手 → 处置后再发 1 次同命令把家族补满（bg-gate 冷却戳与派发提醒照旧兜底）。升级窗口内新旧实例混跑不冲突：旧实例仍按旧语义全清自毁，过渡期少量安静通知属预期。

**fired 仲裁与 abandoned**：同条件两枪最小间隔 5 分钟（错峰，多实例不会重复轰炸）；单条件封顶 3 枪，第 3 枪带 abandoned 标记并追加邮箱回声 + OS toast 兜底（3 枪全丢大概率是平台通知异常——**接手后检查通知链路**，别当没事）。`board(list)` 顶层 `sentinel_health` 给出家族在岗数、24h 开枪记录、abandoned 清单与回声摘要；`resume` 简报在家族缺员/有 abandoned 时给补员建议。

**N=1 警告**：`sentinel_family=1` = 旧版单实例——开一枪就死，丢即死局，无冗余。要防通知丢失请保持 ≥2（默认 3）。

**兜底**：忘了启动哨兵，未签收任务仍会被 Stop 清单与 resume 简报标为"疑似唤醒失败"——两道保险不冲突，但实时唤醒只有哨兵这一条路。**完成通知实测会丢：哨兵家族是冗余防线不是多余动作；收到的每条哨兵告警都按真实事件处置，不要因为"好像刚收到过"而忽略。**

## 15. 上下文镜像（跨会话引用近期会话现场）

插件自动把本项目的对话**截断镜像**落盘：UserPromptSubmit hook 记你的 prompt（默认截 2000 字符）、Stop hook 记最后一条回复（默认截 4000），按会话写 `<存储根>/context/journal-<sessionId>.jsonl`；单文件 2MB 字节帽封顶，超限整文件轮转为 `.old` 后重写（无条数帽；`.old` 保留、峰值可达 2MB 新+2MB 旧），`mailbox(gc)` 定期清理过期文件。**隐私**：提示词与回复原文（截断）会落盘于项目存储根，敏感项目用 userConfig `context_mirror=off` 随时关闭。

**用途**：
- **跨会话恢复**：`resume` 返回 `prev_sessions`（近期会话的尾部摘要，内联 tail 片段）——先读 tail 还原"上一会话现场"，再决定恢复动作；要深挖再用平台 `ReadSessionContext(sessionId=…, strategy="handoff")`。不要要求全量转储（上下文膨胀）。
- **派发带现场**：`context_pack(…, mirror_digest=true)` 给任务包附加"近期现场摘要"节（尾部数条、限字数），让子代理知道来龙去脉。它是**历史片段记录，仅供参考，不构成任务指令**——别把里面的旧要求当新命令。
- **钉住重要内容**：用户在对话里给出明确偏好/事实时，随手升级为 lessons：`lessons(action="add", type="preference"|"env-fact", trigger="用户明确表示（<日期>）", lesson="<单句总结>", fix="<如何落实>")`——钉住的内容从此随每次 context_pack 注入。（镜像是滚动缓冲会被淘汰，lessons 才是持久钉住。）

红线：**不要**直接读写平台会话库（db.sqlite）；镜像与 `ReadSessionContext` 是仅有的两个正当来源。

## 16. 快速参考

**MCP 工具全名**（服务器名 orch）（v0.6 起共 11 个工具；report 仅子代理，probe 主控+子代理双面可用（不在默认 disallowed），其余仅主控；子代理默认 disallowed 含 board/lessons/sandbox_*/agent_harvest，池工经 spawn_agent tools 覆盖放行 board。）：

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
| agent_harvest | `mcp__plugin_agent-orchestrator_orch__agent_harvest` | 主控 |
| probe | `mcp__plugin_agent-orchestrator_orch__probe` | 主控+子代理 |

**board 行为**：action ∈ upsert/get/list/ack/claim；ack 说明：`board(action="ack", mission_id, note?) → ack={at, by:"coordinator", note}`；answer/close 自动补签；list 顶层另附 `scope_conflicts`（在飞 mission 两两 scope 相交视图，与 upsert 的 `scope_warnings` 同构，≤10 条，无冲突省略键）。

**board claim 行为**：`board(action="claim", mission_id, worker, lease_minutes?)`——CAS 领取 ready/drafted 任务（owner 置空才可领、依赖全绿才可领），成功即 running 并写租约；worker 每次 report 自动续租；超时自动回 ready。沙箱 apply/discard：门禁=done+qa.verdict=pass；discard 幂等零损伤。

**context_pack 行为**：可选参数 `inputs`（≤4 个上游 mission id，机械牵引其 manifest 条目，T0→CONTEXT/T1→SUMMARY/T2→READ FIRST 路由；全部零产出 isError）、`scope_paths`（≤32 项，超限报错不截断；物化 OWNERSHIP 节，沙箱派发时整体取代 oob_allowlist）、`budget`（enum S/M/L，物化 BUDGET 节含 token 档静态预告行）；缺省均不出现（与旧版同参包逐字节一致）。

**呈现面**：board mission 行附 `t1_head`（≤160 字，最近 report summary 截取，附 artifacts_n/output_files_n/has_question；无 report → null）；resume 对 done/failed 未签收行附 t1_head，blocked/question 行以 `question_head`（≤160 字）预览（全文仍经 mailbox read）。

**mailbox 行为**：peek 不消费（仅 summary+age）；read 消费事件，details 超 2000 字截断并追加标记 `…[截断于N字]` 与提示句（details 已截断（帽 2000 字）：长文应写文件走 artifacts，邮箱只传摘要）——spool 存证原文不动；answer 留痕并返回 recommended_call。

**manifest/inputs 快照语义**：inputs 牵引发生在组包瞬间、逐字物化进包；上游 manifest 之后更新不回灌旧包——要新鲜就重打包。

**lessons 行为**：action ∈ list/add/promote/retire；list 默认 status=active 按 score 降序；add 可带 contradicts=<旧id> 记反例；候选由 report(kind=done, lessons=[…]) 产生，`lessons(list, status="candidate")` 查看待提炼。

**镜像与哨兵**：镜像文件 `<存储根>/context/journal-<sessionId>.jsonl`（context_mirror=off 可停写）；哨兵命令 `node <插件根>/hooks/bg-sentinel.mjs --once`（后台 Bash，同命令连发 3 次 = 家族满编），退出码 0=寿命轮换（单赢家选举，每寿命周期至多 1 条）/让位，1=告警（含 abandoned 放弃通告）；健康看 `board(list)` 顶层 `sentinel_health`（instances 在岗数 / shots_24h / abandoned / echo_tail）。sentinel.cfg.json 的 `signals` 节空串语义 = 哨兵侧内建默认（rollout_dir 默认 `<homedir>/.zcode/cli/rollout`、tool_usage_db 默认 `<homedir>/.zcode/cli/db/db.sqlite` 只读、mailbox_root 默认 `ZCODE_MAILBOX_ROOT ?? <homedir>/.zcode/mailbox`；server.mjs:504-508）。

**agent_harvest 行为**：`agent_harvest(mission_id|agent_id|session_id, tail?, max_chars?)` → 只读收割子代理 rollout 转录尾部（末条 model-io 记录内嵌全量对话），渲染带角色标签的文本；跨会话可用，TaskOutput 失效时的兜底；无转录（未派发/池工）报错并引导以 report artifacts 为准。

**probe 行为**（v0.6 第 11 号工具，上下文经济第二支柱）：`probe(action, …)` 四 action——`db.query`（SQLite 只读受限 SQL：拒裸 `SELECT *`/别名星、COUNT(*) 放行；LIMIT ≤100 强制；SELECT/WITH 白名单 fail-closed；50 行/页）、`file.head`（首 ≤50 行；`mode:"tail"` 为日志尾读、不分页）、`file.grep`（服务端 grep -m 语义，max_count ≤50/页）、`bin.inspect`（type/size/sha256/首 256 字节，sha256 全文件帽 32MB、超出只哈希前片并在 hash_scope 注明）。单响应 ≤50 行且 ≤10KB，超限分页（`page_token` 原样回传续读；单行截 2000 字、文本扫描窗 1MB/页）；每个 ok 响应都是统一摘要 envelope（rows_truncated/bytes/hash/page_token），永不原文回显。只读、无 board/锁交互、双面可用（不在子代理默认 disallowed）；路径可指向任何可读文件——probe 管的是帽不是沙箱。

**board upsert schema 白名单**（v0.4.1）：未知顶层字段不入库（如 timeline_note），响应以 `ignored_keys` 列出——写错字段名不会再静默改板。v0.5 起可登记 `scope_paths`/`strict_scope`（均整体替换、不入 ONE_LEVEL）；`manifest` 为只读派生字段（upsert 输入侧剥离，沿 ack 先例）。

**kind 枚举**：milestone / blocked / question / done（summary ≤ 200 字；blocked/question 必带 question【硬校验，缺失即 ToolError】；done 必带 artifacts【软约束：server 不做缺失校验，缺省按空数组收，server.mjs:2409】）；milestone/done 可选 `files_touched`（≤50 项仅 schema 声明、服务端无截断/拒绝【与 manifest_entries 的机械强制不同强度，server.mjs:4907-4911】；参与越界审计）与 `manifest_entries`（≤12 条，done 收口写 manifest）。

**mission 状态机**：`drafted →(解锁 blockedBy 全绿)→ ready →(claim)→ running → (blocked|question|done|failed|skipped)`；`drafted → dispatched → running`（普通派发，不经 ready）；`blocked/question →(answer) dispatched/resumed`；`done/failed → closed`；`skipped 为终态（skippedReason=upstream_failed），复核后 closed 归档`；workflow stopped 标 `resumed` 后继续用 running/done。**closed 双门（v0.6）**：写入侧——外部直写 `status:"closed"` 必须携带一次性瞬态键 `close_confirmed:true`（消费后不落板），drafted 禁直达 closed，closed 无离开路径（重开=新建 mission；仅 failed/skipped 可携 `reopen:true`+note 复活为 drafted）；采信侧——依赖解锁中 closed 仅绿归档才算满足（`qa.verdict="pass"` 或 `pack.sandbox.applied_at`），裸 closed 挂起等待、不级联 skip。

**平台编排原语速查**：

- `Agent {description, prompt, subagent_type, run_in_background}`；无 model 参数；同步返回含 `agentId`（agent_<uuid>）；多条放同一消息=并发。
- `SendMessage(to=agent_<uuid>, summary≤200, message≤20000)`：终态=后台恢复续聊（可反复）；运行中=steer。
- `TaskOutput(task_id, block, timeout≤600000)`；`TaskStop(task_id)`。
- workflow：`CreateWorkflow{script|saved|path, name, max_concurrency, subagent_model}`、`AmendWorkflow{run_id, path|script, subagent_model, max_concurrency}`（任何状态可改，旧完成工作导入为缓存）、`ResumeWorkflowRun{run_id}`（仅 stopped）、`GetWorkflowRun`（pendingQuestions）、`ListWorkflowRuns{statuses}`、`ResolveWorkflowQuestion{question_id(dwfq-…), answer}`、`EvalWorkflowSnippet`、`ListModels`、`SaveWorkflow`（需用户同意）。子代理 `escalate` 每 ask 限 3 次。模型：可按子代理在 persona 指定——`agent(name, { system?, model? })`，model 取编译期字面量（可带 `$reasoningLevel`）或 `model("…")` 的 ModelRef，id 取自 `ListModels`；未指定继承 run 级 `subagent_model`；启动期模型名对照 host 模型目录校验并经确认窗口批准；诊断码 9010（编译期 model 值非法）/9011（解析失败，含 fill 引入 run 未绑定的新模型）；工具面仍全局同一、无 per-agent 工具集。
- hooks 仅 7 事件；插件注册 SessionStart（恢复简报）、Stop（镜像记录 + 收工清点，含疑似唤醒失败）、PreToolUse（Agent|Task 后台闸门 + 哨兵派发提醒）、UserPromptSubmit（镜像记录，恒静默）四个；Stop 用 hookSpecificOutput.hookEventName="Stop"+additionalContext；PreToolUse 用 permissionDecision allow/ask + additionalContext；退出码 0 放行。
- userConfig：storage_dir（存储根）、background_gate（remind|ask|off，默认 remind）、background_gate_exempt_types（默认 judge）、dispatch_contract（remind|ask|off，默认 remind；派发契约校验独立开关，bg-gate --contract，background_gate=off 不连坐）、wake_sentinel（on|off，默认 on；派发提醒是否附带哨兵提示）、wake_timeout_min（默认 10；桥接键：未显式传 `--refire-gap-min` 时经 cfg 桥接生效为哨兵两枪最小间隔，V7-05 起桥接可达，见第 14 章桥接注记）、wake_retries（默认 3；桥接键：未显式传 `--wake-cap` 时桥接生效为单条件封顶枪数，同上）、wake_poll_sec（默认 60）、sentinel_family（1-5，默认 3；哨兵家族实例数，N=1 无冗余等于旧版）、sentinel_grace_min（默认 5；done 未签收首枪宽限，blocked/question 自动 3、在飞失联 30、崩溃 10 派生）、context_mirror（on|off，默认 on；off 停止落盘镜像）、context_mirror_max_chars（默认 "2000,4000"）、sandbox_default（none|worktree，默认 none；context_pack 未显式传 isolation 时的默认值）、claim_lease_min（默认 30，最小 1；board claim 自领取租约分钟数）。

**成本速查**：写集 ≥3 拆分、≥8 强制拆；预算档 S≤20 / M≤60 / L≤120 步，硬顶约 120 步或 230K 上下文（L 档派发前预拆）；探针单次 ≤50 行/≤10KB、DB 禁 `SELECT *`；回归 = 新断言全跑 + 旧断言抽样，全量仅发版前/骨架变更/信号链变更；血缘优先：续聊 > workflow 重放 > 重新派发。

## 17. 沙箱派发（sandbox_dispatch）

**适用判据（三条全满足才用）**：任务是改代码；改动可被 git diff 表达；项目本身是 git 仓库（有提交）。调研/文档类任务用普通派发即可；非 git 项目 context_pack 会直接拒绝并引导 git init（不做 copy 降级）。

**七步沙箱变体**：

1. `context_pack(mission_id, title, task, read_first, rules, isolation:"worktree", oob_allowlist:["src/","tests/"])`——materialize 一步建 worktree 沙箱：分支 `orch/<mission_id>`、`<存储根>/sandboxes/<mission_id>/` 工作区、任务包内项目路径前缀改写为沙箱路径并附 SANDBOX 节（红线声明+done 必附 diff 存证）。`share_node_modules` 缺省自动：主仓有 node_modules 且任务不像安装类 → junction 共享（只读使用）；装依赖类任务自动禁共享。
2. 正常派发（Agent run_in_background=true + 三行契约）——worker 在沙箱内干活，原仓路径只读。
3. `report(kind=done, artifacts=[diff-stat 文件, diff-name-list 文件])` → board 置 done。
4. 派 orch-reviewer 审 diff：`git diff --name-only <base_commit>` 逐路径比对 allowlist + `git -C <项目> status --porcelain` 巡检主仓污染。
5. 评审 mission done → 主控把 verdict 抄录到目标 mission：`board(upsert, mission={id:"<目标>", qa:{verdict:"pass", reviewed_by:"<评审id>", reviewed_at:"<时间戳>"}})`（评审 mission 侧以 qa.mission_id 或 artifacts 互指目标 mission）——qa 结构体须过 apply 四查（verdict="pass"；reviewed_by 指向 done/closed 的评审 mission；其 agent_type 含 reviewer；评审 mission 互指目标 mission），缺任一项 apply 明确报错、不静默降级。
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

**phase-2 漂移策略（v0.6 两阶段 apply）**：apply = 锁内 phase-1 写 `apply_intent_at` intent → 锁外 phase-2 git 管线 → 锁内 phase-3 重读收口（intent 新鲜窗 10min；在飞时 busy 返回 `apply_in_progress:true`，discard 撞新鲜 intent 被拒）。phase-2 期间板上发生的 status/qa 漂移**不回滚 merge——applied 胜出**，漂移以响应 `warnings` 呈现（phase-3 只硬校验身份 id+branch+base_commit；merge 已落主线不可逆，以 git log 为准人工核对）。

**`--strict-tokens` 开关（v0.6，默认 off）**：注册落点 = server 启动参数（`node <插件根>/mcp/server.mjs --strict-tokens`）。off = v0.5.1 行为（带派发 token 的 mission 严格校验，无 token 派发放行）；on 时无派发 token 的 report 一律拒收（先 context_pack 铸发 token 再派发），且 `agent_harvest` 仅接受 mission_id 定位（session_id/agent_id 直读收口为经板面解析 dispatch）。

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

**解锁/级联语义**：`blockedBy` 全部 done/skipped/closed → drafted 自动解锁为 ready（**closed 算满足**仅限绿归档——`qa.verdict="pass"` 或 `pack.sandbox.applied_at`；裸 closed 挂起、不级联 skip，见第 16 章双门）；任一上游 failed/skipped → drafted/ready 级联为 skipped（skippedReason=upstream_failed，**skipped 算失败信号不是满足**——下游要么一并 skip，要么修订 blockedBy 重规划）。扫描在每次 board 写事务内 fixpoint 执行（done 事务同步解锁/级联），链式失败一次扫清；成环的 blockedBy 变更直接拒绝（依赖必须是 DAG）；悬挂引用（指向不存在的 mission）在扫描时自动清理。

**claim CAS 与租约**：`board(action="claim", mission_id, worker, lease_minutes?)`——owner 为空且状态 drafted/ready 且依赖全绿才可领；成功即 running 并写 {worker, token, claimedAt, leaseUntil}（token 缺失时补发）。worker 每次 report 自动续租（缺省租约取 userConfig `claim_lease_min`=30）；超时未续自动回 ready 可再领取（下一个写路径顺带回收，无需定时器）。两个池工抢同一任务，根锁内 CAS 恰一人成功，另一人 isError 附当前 owner。

**池工模式**（同构任务池才需要，普通派发用不上）：主控显式 spawn 一个放行 board 的角色——`spawn_agent(name="orch-pool-<tag>", archetype="worker", tools=["report", "mcp__plugin_agent-orchestrator_orch__board"], system_prompt="你是池工：循环 claim→干活→report→再 claim，直到 claim 全部失败（无 ready）后正常结束；不要 upsert/ack，那两件事归主控")`——宿主快照缺陷期间池工一律经 `Agent(prompt=原型正文+system_prompt)` 注入派发（typed 挂不上 board/report 等 MCP 工具，第 10 章主形态）。池工 claim 成功后按 next_hint：先 Read 任务包按 TASK/RULES 执行；期间每完成一步 report（自动续租）；完成后 report(kind=done)。

**口径（逐字）**：ready 且无人领取的任务不算未竟、不触发哨兵与收工清点——任务池空转不是事故；领取成功即 running，才进入在飞与唤醒体系。

## 19. 主控并行迭代规程（多轮流水线）

长任务（多步改造、持续集成式开发）不要串行等待：把"调研→设计→实现→QA/评审"拆成迭代，让多轮同时在飞。

**流水线规则（核心判据——输入冻结才准开工）**：第 N+1 轮的调研/设计可以在第 N 轮进入 QA/评审时启动，前提是 N+1 的输入已经冻结。冻结判据（全部满足才算）：
- 输入是已落盘的文件/文档（不是"我一会儿再改的想法"）；
- 与上一轮的交集只有"上一轮的产出作为只读上游"——上一轮评审若打回，改动面不波及本轮已开工部分，或波及时本轮尚在读上游阶段（便宜重做）；
- 本轮 mission 的任务包已用 context_pack 物化（上游产物逐字进包）。
拿不准就别并发：串行一条链也是合法规程。

**并发上限**：同时在飞的 mission ≤ 8（平台单会话并发约 8 的硬约束）。迭代任务排队，完成的签收一个、放出下一个。

**mission 与哨兵**：每次迭代 = 独立 mission（独立 pack/独立 token/独立 artifacts），禁止多轮共用一个 mission。哨兵家族全项目只一套（同一命令连发 3 次即满编，槽位防超编）：启动一次即可覆盖所有迭代的 mission——每轮新派发自动纳入盯守，不需要每轮各拉哨兵；实例开枪后其余实例继续值守，处置后补员即可（第 14 章）。

**聚合纪律**：每轮产出**全文落盘**（写进存储根下的文件，路径记进 mission artifacts），你只把 ≤200 字摘要带进上下文。下一轮的上游上下文用文件路径（read_first）引用，不要把上一轮全文粘进任务包——上下文膨胀的第一杀手就是把子代理长文原样读回主控。

**多迭代同转时的签收与恢复**：
- 签收按 mission 粒度：哪个轮次的结果到了就处理哪个，`mailbox(read, mission_id=…)` 定向消费；其余轮次不受影响。
- done 后先评审（QA mission）再 close；配合沙箱派发时按第 17 章走 qa → sandbox_apply/discard。
- 哨兵告警/疑似唤醒失败只针对具体 mission，处置它不阻塞其余迭代。
- 会话中断后：resume 简报按 mission 列出全部在转迭代与 recommended_action，逐项恢复即可——连续性靠 board+文件，不靠记忆。
- 迭代编号进 title（如「v2 迭代：搜索重构——实现」），Stop 清单与简报里才扫得清轮次。

## 20. 成本纪律（cost-rules）

**为什么**：遥测实证——Read 输出占工具字节 56–78%、编辑仅 0–3%；单代理上下文 53K→352K 单调增长能把 50M token 烧在重放上（99.2% 已是 cache 重放仍拦不住二次方曲线）。成本的主战场是"读回"与"重放"，不是"编辑"。四条杠杆：砍上下文（分区）、砍步数（预算）、重放免费化（血缘）、砍读回（探针与锚点）。

### 20.1 文件所有权分区
- 派发前先盘点**写集**（会被 Edit/Write 的文件）：≥3 个文件或跨 ≥2 个顶层目录 → 拆成 scope 不相交的多个 mission；**≥8 个 → 必须拆**。强耦合的原子重构除外（单 mission + 沙箱）。
- 切分优先级：目录 > 层 > 变更类型；被多个子集引用的**枢纽文件**（如 server.mjs）归单一 mission 独占，其余只读。禁止"按话题切但都落在同一文件"的假并行。
- 写集用 `board(upsert, mission={id, scope_paths:[...]})` 登记并经 `context_pack(scope_paths=...)` 物化进 OWNERSHIP 节（目录条目必须以 `/` 结尾）；两个在飞 mission scope 相交时 board 响应 `scope_warnings`（`strict_scope:true` 则拒绝登记）。
- 两个在飞 mission 的写集相交 → **三选一**：后写者 blockedBy=[前写者] 转串行；改沙箱分叉各自 apply；重切把相交文件归一边独占。**禁止裸并行写同一文件。**

### 20.2 分叉与缓存经济（选形态先看血缘）
| 场景 | 形态 | 缓存语义 |
|---|---|---|
| 一次性、异构、并行 | 独立 Agent 派发 | 冷启全自费 |
| A/B 对比、多风格 | 变体分叉 variants=N | 共享 upstream 前缀只是打包便利；跨任务缓存不可依赖——分叉的理由是对比不是省钱 |
| 多阶段流水线、预期 amend | 同 workflow 命名代理 | journal 重放免费（Amend 零成本导入已完成工作） |
| 修正、补遗、答题续做 | SendMessage 续聊终态代理 | 原对话在场，只付增量 |
| 改代码要安全合并 | 沙箱派发 | 同独立派发 + 隔离开销 |
- 原则：**有血缘就用血缘**（续聊 > workflow 重放 > 重新派发）。重新派发前先问："它的上下文还在吗？"——在就续聊，别重付物化税。
- 确须重派时，任务包给最低但充分的四件：上一版断言原文+实装语义、被引设计章节**原文**、函数/行号锚点清单、环境事实。禁止把上一轮全文粘进包。

### 20.3 上下文预算（强制点）
- 派发前定档：**S ≤20 步 / M ≤60 步 / L ≤120 步**，写进任务包 BUDGET 节；**L 档必须预拆阶段或转 workflow**，不许先跑着看。
- **token 档位（CR-09 v0.5；主控对账时以 `agent_harvest(tail=0)` 探测模式采样，零转录回显）**：WARN ≥120K → 对账时提醒逼近；**ACT ≥150K → 按浓缩/拆分/放弃决策表处置**（**拆分是默认动作**：steer 收尾 + 按 files_touched 续派；**浓缩是受控例外**——上下文大而产物少（artifacts ≤2）、连续性价值高时派 S 档浓缩代理产出七节交接包 + manifest 条目 + 状态重建清单，后继者全新冷启派发；**浓缩边界四条：①每 mission 最多 1 次；②浓缩≠同会话续跑（平台无压缩 API，浓缩代理是新会话，签收后原 mission closed）；③浓缩后再达 ACT → 强制拆分或放弃，禁二次浓缩；④死亡/失联仍归 agent_harvest，浓缩不兜死亡**）；**HARD ≥180K → 强制收尾**：steer"完成当前阶段、report(done) 附遗留清单"，剩余拆新 mission（以 files_touched 为完成度基线）；**ABS 230K 为文档红线**（实测 p95 已 253K——防线靠前移到 ACT/HARD，不靠事后拦截）。
- 对账点 = 每次 milestone report（要求 worker 附进度与剩余步数估计）：milestone 同时是哨兵失联宽限的续期信号，对账搭同一班车、零新增轮询。哨兵不管预算，预算是你对账时的事。worker 的 `files_touched`（milestone/done 可选附带）落 timeline，既是越界审计基线，也是中断接力的每文件完成度清单。

### 20.4 探针与读回纪律
- DB 探针**禁 `SELECT *`**：列字段 + 聚合/COUNT + LIMIT ≤100；二进制只回显类型/大小/哈希/首 256 字节；日志用 tail ≤50 行或 grep -m。单次探针输出 **≤50 行或 ≤10KB**，超限分页。
- 派发时把函数/行号锚点清单写进任务包；**≥1000 行的文件禁一次全文读入**（先 grep 结构再定点读）；同一会话已读的文件不重读。
- （结构化 probe 工具已 v0.6 实装为 server 强制帽——`probe` 四 action 见第 16 章 probe 行为；会话级读缓存仍为机制候选，实装前以上是纯纪律。）

### 20.5 验收断言链与回归分层
- 每版验收断言**沉淀为文件**（`tests/assertions/v<版本>.md`，逐字措辞 + 实装语义注记，带 ID）；下一版验收 mission 的 read_first 必含上一版断言文件——断言不靠文档措辞口口相传。
- 验收 harness（fixture/加速参数/捕获脚本）沉淀 `tests/harness/`，复用优先，禁止每轮自建。
- 回归分层：**全量仅限发版前、骨架变更（board 格式/hooks 事件/工具清单）、哨兵信号链变更**；日常迭代 = 新断言全跑 + 旧断言抽样（直接层全跑、邻接层抽 1/3、远端层免跑）。
- 任务包与设计的用例口径必须对齐：包内 TASK 逐条引用断言 ID，数量与断言文件一致。

### 20.6 守闸门纪律矩阵（单一事实源；第 4/6 章只引用不复制）

主控对各 mission 形态只读什么（防验收闸门失守，行为对照全部为实测实证）：

| mission 形态 | 主控允许读什么 | 机制支撑（v0.5 落地后） | 条文落点 |
|---|---|---|---|
| done（普通） | T1（t1_head ≤160 字）+ artifacts/output_files **路径列表**；禁读 details 长文与产物全文 | t1_head 呈现字段；mailbox details 呈现帽（2000 字）；worker 侧纪律"长文写文件走 artifacts" | 第 4 章 done 行注记 |
| failed | 同 done + lessons 候选清单（查询，不进正文） | resume 的 t1_head 覆盖 done/failed 未签收 | 并入 done 行，零机制 |
| question/blocked | 只读 question（+age），立即答或派 scout | 现状已合规；仅补呈现帽 question_head ≤160，全文留 mailbox read | 第 4 章 kind=blocked/question 行 |
| QA/review（沙箱） | **豁免条款**：reviewer（worker 侧）读 T0 断言原文 + diff + allowlist；**主控只读 verdict 结构（qa 字段）、不复述 diff** | qa 机械门禁与 apply 越界比对不动；manifest assertion 条目机械比对供 verdict 输入 | 第 17 章；reviewer read_first 必含断言文件 |
| 浓缩代理（S3 新形态） | 主控读浓缩产物**全文**——它本身就是 T1 | 无新机制（七节交接包/manifest 条目/状态重建清单三件套即呈现面） | 20.3 节受控例外（占位防漏） |
| workflow 在飞/pending | 状态与 pendingQuestions | recommendedAction 四支不动 | 无差距 |

manifest/inputs 速查：done 可带 `manifest_entries`（≤12 条；条目七字段 id/layer/type/title/text/ref/source，type 封闭五值 assertion｜env_fact｜anchor｜conclusion｜directive，断言条目 ref.loc 用断言文件 ID 如 `tests/assertions/v0.4.x.md#V-12`）→ server 收口校验/截断后写 sidecar 并挂 mission.manifest 指针；`context_pack(inputs=[mission_id])`（≤4 个）按层确定性路由——T0 逐字块入 CONTEXT（合计 ≤24KB）、T1 一行入 SUMMARY（合计 ≤4KB）、T2 指针追加 READ FIRST（≤20 条）；**快照语义**：牵引发生在组包瞬间、逐字物化进包，上游 manifest 之后更新不回灌旧包——要新鲜就重打包。

## 21. 唤醒 watcher（远程唤醒守护进程，v0.7.1）

**定位与分工**：哨兵家族（第 14 章）管「本地后台完成通知丢失」的分级补枪；watcher 管「异地/移动场景把主控会话敲醒」——经平台 remote 中继（ws2）向目标会话注入固定模板壳（`[orch-watch] mission=<id> state=<…> summary=<≤200字模板摘要> 指引=请消费 spool/<event_id>.json`），**只发 id+状态+指针、禁内联 worker 原文**（提示注入放大器纪律，正文永远留在 spool 走既有闸门）。board 签收/消费流程零改动：watcher 只敲醒、不替代你消费。两通道互补不互替：远程唤醒走云、本地唤醒走哨兵。

**启动（常驻进程；须用户显式授权——W-G §5 条件 C1；停用=进程退出+token 自然过期，一键可断）**：

`Bash(command="node <插件根>/watcher/watcher.mjs --root <存储根>", run_in_background=true)`

参数（解析三层 CLI > `<存储根>/watcher.cfg.json` > 内建默认；零 npm 依赖，node ≥ 20）：`--origin`（默认 https://zcode.z.ai）、`--poll-sec 30`、`--min-interval-sec 90`（两事务最小间隔=60s 防抖窗+50% 裕量）、`--wake-cap 3`（per-mission 封顶，沿哨兵 cap 语义）、`--hold-max-sec 40`（单事务持有帽 ≤60s TTL）、`--busy-silence-min 30`、`--trigger-statuses done,failed,blocked,question`、`--heartbeat-sec 60`、`--once`（单轮试跑）。定根 `--root` 优先、**从不读 root.txt 指针**（站 server 侧）；每 60s 写 `<存储根>/sentinel/watcher-heartbeat`（mtime 即心跳）。

**两道门（施工前置，均已实测通过）**：
- 门 A 凭证合规（EXP-1 已过）：terminal token 签发强制平台登录态（无 Bearer 即 401）；`expires_in=60s` → **签发即用、用后即弃、不落盘不缓存**（JWT 只在签发瞬间经手，续签语义问题消解）。
- 门 B 互踢级联（EXP-2 已过+边界条件）：terminal 槽位短事务（连-发-断）不触碰桌面 device 连接的 kick 计数，级联未发生（护栏内两事务全净）。**边界条件如实**：对手终端互踢不可观测（实验窗桌面无挂接终端、护栏禁止自造对手连接），故保守频控（≥90s 间隔/cap=3/busy 静默 30min）维持不放宽。EXP-3 定案：token TTL 只是握手门票非硬切，单连 30×TTL 零异常。

**成功判定（三证合一，替代哨兵回声计数）**：① rpc-frame-ack（传输送达）② session/send 受理无 -32010 ③ 判定窗 60s 内 rollout 心跳复活/prompt_started。②=busy → 主控本就在跑，**no-op 成功不计失败**（防对活跃会话连枪）；①②成③不成 → 记 accepted-not-revived，哨兵照常兜底、不重复注入。

**降级树（degrade.mjs；终态不退出进程——「永不因失败退出」，停事务面保心跳等人工）**：
- **D1 凭证终态**：签发 401/AUTH_FAILED/close 4004·4013、4011 重签再败 → standby+桌面重登指引（`[orch-watch] D1 凭证终态…`），唤醒由哨兵全量接管。
- **D2 临时弃发**：ws 建连败/握手超时/心跳判死/桥接错误重试 1 次仍败/rpc-frame 无 ack → 本轮弃发写 signals，下轮 POLLER 自动恢复。
- **D3 配置终态**：workspace-list 空/close 4004·4012（coord-session 失效或桌面未开远控）→ 配置告警等人工。
- **kicked**（用户顶掉 watcher）=正常生命周期，静默退出且**绝不重连**（复刻桌面侧自动重连=60s 防抖窗内制造第二踢，全设计第一禁令）。事件流：`<存储根>/sentinel/watcher-signals.jsonl`。

**安全清单（凭证五禁+EXP 实测六条）**：凭证文件在 orchestrator 存储根**外**独立路径；JWT 用后即弃不落盘；唯一允许落盘的凭证物=role token（短时效）。五禁：禁入 git、禁入日志（任何出口对 token 形态 REDACTED 并可 grep 自检）、禁入 spool、禁入 echo.jsonl/mission timeline、禁入上下文包（inputs 机械牵引面）；probe 白名单排除凭证路径。EXP 实测六条：①expires_in=60s 是握手门票非硬切（长连穿越 TTL 边界稳定存活）；②全链建连 ~0.26s（sign 93ms+ws_open 97ms+auth_ack 166ms）；③auth_ack `pair_status:"matched"` ~100-166ms 即插即配（slot 空时）；④terminal 侧无心跳要求，30 分钟静默存活不被切断（挂接 burst 2×data=状态同步非心跳）；⑤桌面日志 `%USERPROFILE%/.zcode/v2/logs/<date>.log` 的 `[web-remote-control] V2 device state` ±0.2s 精确镜像 watcher 挂/拆（独立观测点）；⑥事务期间桌面 device 连接全程 online、状态仅 paired↔waiting_terminal 干净迁移。

**与哨兵职责互换（反向监控）**：设计分工=watcher 接管唤醒、哨兵 v2.1 降为「watcher 存活监控+回退唤醒」（心跳超龄即告警并按回退路径补枪）；watcher 进程死亡**不自动拉起**（不做守护守护进程的无限递归），交用户/主控处置。**现状如实**：watcher 侧心跳/watcher-signals 写入面已落地，bg-sentinel 对 `watcher-heartbeat` 的消费面**尚未接线**（hooks 零 watcher 引用）——反向监控告警当前靠人工巡检心跳文件 mtime，哨兵侧接线列后续卡。

## 22. 记忆归敛（v0.8）

**定位**：lessons 库是事件层（只增不重排），主控与子代理的记忆视图是视图层——ORCH.md（你的记忆文件）、根 AGENTS.md 标记区（子代理记忆）、全端 AGENTS.md（跨项目子代理记忆）。**归敛（glean）**= 后台子代理定期把事件层整理进视图层：消费 ORCHTEMP、巡检晋升候选、维护超帽裁剪，产出归敛报告。设计权威 (internal design docs, not published) §6/§9。

### 22.1 文件地图

| 文件 | 落位 | 说明 |
|---|---|---|
| `<存储根>/ORCH.md` | 项目存储根 | 你的记忆视图（帽 120 行/10KB；超帽 server 截断兜底并提示；你只消费不直写） |
| 项目根 `AGENTS.md` 标记区 | 项目根 | 子代理记忆（硬帽 60 行/4KB；归敛只动标记对内） |
| `<全端目录>/AGENTS.md` | 全端目录 | 跨项目子代理记忆（帽 50 行/2KB；经 context_pack GLOBAL MEMORY 条件节注入，`glean.cfg.json` 的 pack_global_section 一键关） |
| `<存储根>/memory/lessons.jsonl` | 项目库 | 事件层（项目） |
| `<全端目录>/memory/lessons.jsonl` | 全端库 | 事件层（跨项目；检索读端双库合并，§13） |
| `<全端目录>/glean-lock.json` | 全端目录 | 归敛互斥锁（done 态保留：mtime=上次归敛时间、watermarks=事件基线） |
| `<全端目录>/glean.cfg.json` | 全端目录 | 门槛与帽值（缺省内建：48h/10 条/锁过期 1.5h） |
| `<全端目录>/glean-brief.json` / `projects.jsonl` / `reports/` | 全端目录 | server 物化的归敛简报 / 注册项目名册 / 归敛报告 |
| ORCHTEMP | lessons 库内 source="orchestrator" 的 candidate 条目 | 你的随手暂存（§13 stage），归敛消费 |

（全端目录缺省 `<~/.zcode>/orchestrator-memory`，`--memory-root` 可覆盖。）

### 22.2 ORCH.md ver 同步（自动捎带的消费规则，逐字）

任一工具调用成功响应可能附顶层 `orch_memory.orch_md`：收到 `reason:"initial"` → 静默装载；`"changed"` → 以新全文替换旧文认知；`"removed"` → 清空认知；`truncated:true` → 视为超帽信号，考虑拉起归敛。你不写 ORCH.md（归敛写），只消费。

### 22.3 归敛到期信号与处置（信号链，逐字规则）

门槛在 server 每次工具调用时评估（门①距上次归敛 >48h；门②双库自水印以来新增 ≥10 条；两值与帽值集中 `glean.cfg.json` 可覆盖；成本排序=先查时间一次 stat、再数事件，才谈抢锁）。双门全过且锁闲 → server 物化 `<全端目录>/glean-brief.json`（现场快照：实测门槛值/水印/ORCHTEMP 待消费 id/名册/ORCH.md ver/cfg 全文）并在响应附 `orch_memory.glean={due:true, reason, brief_path, lock_state}`。处置：`due:true` 且锁闲 → Read brief → **后台 GP+orch-gleaner persona 派发**（任务包骨架=DESIGN §9.5：CONTRACT 三行；CONTEXT 逐字贴 brief 全文+本项目 ORCH.md 现文+根 AGENTS.md（标注标记对位置）+全端 AGENTS.md 现文；TASK=抢锁→消费 ORCHTEMP（retire 置状态）→候选巡检 promote→视图层维护（ORCH.md 重写 ver+1/标记区外科编辑/全端 AGENTS.md 更新）→锁置 done+watermarks→写报告；RULES=红线四条+标记对外字节零触碰+标记对缺失=该项目关闭跳过；OWNERSHIP=全端目录全部+各注册项目根 AGENTS.md 仅标记对内+各注册项目 ORCH.md，lessons 只经工具）；`lock_state:"busy"` 或不感兴趣 → 忽略——**信号不消费无后果**，下次调用按门槛重新评估。组包后 grep pack.md 验证 CONTEXT 物化（缺陷候选 #52 纪律）。

### 22.4 开启/关闭

- **开启（一次性，主控手工，归敛永不代劳）**：在项目根 AGENTS.md 末尾（用户手写区之后）加入空标记对：

```
<!-- orch-mem:begin v1（agent-orchestrator 记忆区：对内内容由归敛代理维护，勿手编；删除本对=关闭本功能） -->
<!-- orch-mem:end -->
```

- **关闭**：删标记对即可。**被删=功能关闭，归敛跳过该项目并在报告记录（「标记区缺失，视为关闭」），不重建、不补写、不提示重建**；重开=用户/主控手工再加空标记对。

### 22.5 审阅面（事后承担，无事前 ack 门）

归敛产出三重可审：①**归敛报告** `<全端目录>/reports/<YYYYMMDD-HHmmss>-glean.md`（帽 150 行；视图变更/晋升/ORCHTEMP 消费逐条带 lessons id 溯源——主审计面）；②ORCH.md ver 回显（22.2 自动）；③git diff（根 AGENTS.md 属 tracked 文件可用；.zcode 下视图文件不入 git，以报告为准）。发现滥晋升/写越界/红线违反 → 手工纠偏（git 回滚标记区、`lessons(action="retire"/"add", contradicts=…)` 记反例）并沉淀教训。**active 退役归敛无权限动手，只有建议权**——否决或采纳都是你的手工动作。

### 22.6 快照语义与形态注记

- 子代理读到的是**父解析时点快照**：会话中途归敛改 AGENTS.md，已派发在途子代理不生效、新派发生效——不为此打断在飞任务。
- Explore 形态不注入 AGENTS.md → 项目标记区通道对它静默失效；全端级经 context_pack GLOBAL MEMORY 节覆盖此洞。

### 22.7 手动拉起

不待信号：任何时候可按 22.3 的任务包骨架直接组包派发 orch-gleaner（等效手动触发，无专设命令面——锁在全端目录仲裁跨项目并发，抢不到锁的实例 report done skipped 自动让位）。
