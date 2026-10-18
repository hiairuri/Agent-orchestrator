# agent-orchestrator 插件设计文档

版本：0.6.0 ｜ 日期：2026-10-19 ｜ 读者：编码子代理（可据此直接照写代码）
本文档是唯一设计权威。所有平台事实均经 ZCode CLI 源码核实，编码时不得偏离第五节的平台约束。

---

## 0. 一句话使命

让 ZCode 主控 agent 成为真正的任务指挥官：能派发、能并行、能分叉、能选模型、能被提问并作答后让子代理继续、能恢复中断（同会话与跨会话），且在它想收工时被 hook 拉回来清点未竟事项。

## 1. 六项核心功能 → 机制映射（必须全部落实）

| # | 功能 | 机制 |
|---|------|------|
| 1 | 恢复中断的子代理 | 同会话：`SendMessage(to=agent_<uuid>)` 恢复终态子代理；workflow：`ResumeWorkflowRun`/`AmendWorkflow`。**跨会话**：`board.json` 持久化 mission（原始 prompt/agentType/model/ids/产物路径/blocked 问题），SessionStart hook 注入恢复简报，`resume` MCP 工具产出接力计划。跨会话 agentId 失效 → 恢复 = 新派发同类型角色 + `context_pack` 重建上下文（连续性靠文件，不靠 agentId）。 |
| 2 | 自定义子代理 | 插件自带 3 角色 `agents/orch-{worker,scout,reviewer}.md`；`spawn_agent` MCP 工具运行时把新角色写入 `<项目>/.zcode/agents/<name>.md`（内嵌 archetype 模板）。 |
| 3 | 选择子代理模型 | 角色 .md frontmatter `model` 字段 = 一角色一模型（`spawn_agent` 可带 model 生成变体角色）；workflow 支持脚本内 per-agent 选模型：`agent(name, { system?, model? })` 的 model 取 `"modelId"`/`"providerId/modelId"` 字面量（可带 `$reasoningLevel` 后缀如 `"GLM-5.3$high"`）或 `model("…")` 返回的 ModelRef（声明表置顶，agent() 创建时冻结），启动期对照 host 模型目录校验（modelBindings 记 journal）并经用户确认窗口批准，host 无模型目录则拒绝启动；未指定 persona.model 的子代理缺省继承 run 级 `subagent_model`（`CreateWorkflow/AmendWorkflow` 设置 + `ListModels` 查询）。优先级：persona.model > subagent_model > 会话模型。Agent 工具无 model 参数（平台事实）。 |
| 4 | 子代理分叉 | `context_pack` 把上游上下文**逐字物化**到文件并生成 N 份变体包 → 主控在同一条消息里发 N 条 `Agent(run_in_background=true)` 并发 fan-out；或写进 workflow 脚本 fan-out——workflow 路径可每变体一模型（``agent(`变体-${i}`, { model: MODELS[tier] })``，MODELS 为脚本顶部 ModelRef 表），支持快模型探索+强模型精作与分诊路由。 |
| 5 | 子代理提问、主控作答后继续 | 双通道路由：常规 → `report(kind=blocked/question)` 写文件邮箱，主控 `mailbox(read)` 轮询消费；紧急四情形 → 子代理用内核 `RespondToCoordinator` 直达唤醒主控（仅当主控发过消息才出现该工具）。主控 `mailbox(answer)` 记录答案并返回建议的 `SendMessage(to, summary, message)` 调用（运行中=steer，终态=resume）。workflow 场景：子代理 `escalate` → 通知/dwfq-id → `ResolveWorkflowQuestion`；兜底 `GetWorkflowRun` 的 `pendingQuestions`。主控答前可另派 scout 查证。 |
| 6 | 后台并行、主控继续活动 | `Agent(run_in_background=true)` + 完成通知；多条 Agent 调用放同一消息即并发（上限≈8）；**Stop hook** 在主控收工时扫描 board+spool，有未竟事项则注入 `hookSpecificOutput.hookEventName="Stop"` + additionalContext 清单（超越参考实现"文件事件无唤醒通道"的缺陷）；SessionStart hook 检查跨会话可恢复任务。 |

## 2. 完整文件树

```
<workspace>/plugins/
  marketplace.json                          # 由 upsert 脚本生成（见 §3.3）
  agent-orchestrator/
    DESIGN.md                               # 本文档（非加载组件）
    .zcode-plugin/
      plugin.json
    .mcp.json
    mcp/
      server.mjs                            # 单文件 MCP 服务器，零依赖
    hooks/
      hooks.json
      session-start.mjs
      stop-check.mjs
    agents/
      orch-worker.md
      orch-scout.md
      orch-reviewer.md
    commands/
      orch.md
      orch-spawn.md
      orch-resume.md
      orch-fork.md
      orch-model.md
    skills/
      agent-orchestrator/
        SKILL.md                            # 插件的心脏：主控操作手册
```

运行时落盘（默认在**项目内**，可用 userConfig 覆盖根）：

```
<项目>/.zcode/orchestrator/
  root.txt            # 可选指针文件：用户自定义根的绝对路径（单行）
  board.json          # 持久任务板
  spool/<mission_id>/unread/<15位零填充ts>-<8hex>.json
  spool/<mission_id>/read/   （同名文件，rename 消费）
  spool/<mission_id>/answers/<seq>-answer.json   # 主控答案留痕
  packs/<mission_id>/pack.md | pack-v1.md ... pack-vN.md
  archive/board-<ts>.json                        # gc 归档的 closed missions
```

## 3. 清单与注册文件（完整 JSON）

### 3.1 `.zcode-plugin/plugin.json`

```json
{
  "name": "agent-orchestrator",
  "version": "0.1.0",
  "description": "Turn the ZCode main agent into a true mission commander: dispatch, fork, resume, per-role models, subagent Q&A with resume, background parallelism with Stop-hook accountability.",
  "description_i18n": {
    "zh-CN": "把主控 agent 变成真正的任务指挥官：派发、分叉、恢复、按角色选模型、子代理提问-作答-继续、后台并行与收工清点。"
  },
  "author": { "name": "agent-orchestrator maintainers" },
  "keywords": ["orchestration", "subagents", "workflow", "agents", "resume"],
  "skills": "./skills",
  "commands": "./commands",
  "hooks": "./hooks/hooks.json",
  "mcpServers": "./.mcp.json",
  "agents": "./agents",
  "userConfig": {
    "storage_dir": {
      "type": "directory",
      "title": "存储根目录 / Storage root",
      "description": "任务板 board.json 与邮箱 spool 的落盘根目录。留空则使用 <项目>/.zcode/orchestrator。/ Storage root for the task board and mailbox. Empty = <project>/.zcode/orchestrator.",
      "default": "",
      "required": false
    }
  }
}
```

注意：不使用 `sensitive`（平台事实：sensitive 值 UI 无法输入）。

### 3.2 `.mcp.json`（插件根）

```json
{
  "mcpServers": {
    "orch": {
      "type": "stdio",
      "command": "node",
      "args": [
        "${ZCODE_PLUGIN_ROOT}/mcp/server.mjs",
        "--root",
        "${user_config.storage_dir}"
      ],
      "cwd": "${ZCODE_PROJECT_DIR}",
      "timeoutMs": 120000
    }
  }
}
```

会话内工具全名前缀：`mcp__plugin_agent-orchestrator_orch__`。
`--root` 可能为空串：服务器必须把空/缺失视作"未设置"，回退 `path.join(process.cwd(), ".zcode", "orchestrator")`（cwd 即 `${ZCODE_PROJECT_DIR}`）。

### 3.3 `marketplace.json`（`<workspace>/plugins/marketplace.json`）

优先用现成脚本生成（自动生成合规名 `dev-<label>-<hash8小写>`）：

```bash
node "C:\Users\jirai\.zcode\cli\plugins\cache\zcode-plugins-official\plugin-creator\0.1.1\skills\plugin-creator\scripts\upsert-dev-marketplace.mjs" \
  "<workspace>\plugins\agent-orchestrator" \
  --display-name "Agent Orchestrator" --name-zh "子代理主控台" \
  --description-zh "派发/分叉/恢复子代理、按角色选模型、问答续跑、后台并行与收工清点"
```

若手工写，结构如下（name 必须匹配 `dev-<label>-<hash8小写>`，以脚本输出为准，不得臆造 hash）：

```json
{
  "name": "dev-workspace-00000000",
  "description_i18n": { "en": "Local dev marketplace", "zh-CN": "本地开发市场" },
  "owner": { "name": "workspace" },
  "plugins": [
    {
      "name": "agent-orchestrator",
      "source": "./agent-orchestrator",
      "version": "0.1.0",
      "description": "Mission-commander orchestration for ZCode subagents.",
      "description_i18n": { "zh-CN": "子代理主控台：派发、分叉、恢复、选模型、问答续跑。" },
      "displayName": "Agent Orchestrator",
      "displayName_i18n": { "zh-CN": "子代理主控台" },
      "category": "developer-tools",
      "keywords": ["orchestration", "subagents", "workflow"],
      "author": { "name": "agent-orchestrator maintainers" }
    }
  ]
}
```

## 4. MCP 服务器规格（`mcp/server.mjs`）

### 4.1 通用行为

- 单文件 .mjs，Node ≥18，**零 npm 依赖**；仅 import `node:fs`、`node:path`、`node:crypto`、`node:os`、`node:readline`。**禁止任何网络请求**（不 import fetch/net/http；工具描述里出现 URL 仅为文档）。
- 传输：stdio 上**换行分隔的 JSON-RPC 2.0**，`readline.createInterface({input:process.stdin})` 逐行 `JSON.parse`。
  - `initialize` → 回 `{"protocolVersion": <回显客户端 string，否则 "2024-11-05">, "capabilities":{"tools":{}}, "serverInfo":{"name":"agent-orchestrator-orch","version":"0.1.0"}}`。
  - `notifications/initialized`（无 id）→ **不回**。
  - `ping` → 回 `{}`（包成标准响应）。
  - `tools/list` → 6 个工具描述符（§4.3–4.8）。
  - `tools/call` → 分发执行；成功回 `{"content":[{"type":"text","text":JSON.stringify(result)}]}`，业务失败回同结构 + `"isError":true`；未知方法 → `{"code":-32601,"message":"Method not found"}`；单行解析失败 → `-32700`。
  - 诊断/日志只写 stderr。
- 启动：解析 argv `--root <dir>`；空/缺失 → 回退默认；`mkdirSync(root,{recursive:true})`。**若显式 root ≠ 默认根**，把解析后的绝对路径写入默认根下 `root.txt`（供 hook 脚本发现，见 §9）。每次写前做路径包含校验：`const rel = path.relative(root, p); if (rel.startsWith("..") || path.isAbsolute(rel)) throw`。
- 原子写：所有写 = `writeFileSync(tmp)` + `renameSync(tmp, target)`（tmp 名带 pid+4hex）；Windows 上 rename 目标已存在会抛 → 消费 rename 前检查目标存在则追加 `-1` 后缀重试一次。
- board 修改统一走 `loadBoard() → mutate → saveBoard()`（读-改-原子写），接受小窗口竞态（单写者=本服务器进程）。

### 4.2 工具全名总表

| 短名 | 完整全名 | 面向 |
|---|---|---|
| board | `mcp__plugin_agent-orchestrator_orch__board` | 主控 |
| report | `mcp__plugin_agent-orchestrator_orch__report` | 子代理 |
| mailbox | `mcp__plugin_agent-orchestrator_orch__mailbox` | 主控 |
| spawn_agent | `mcp__plugin_agent-orchestrator_orch__spawn_agent` | 主控 |
| context_pack | `mcp__plugin_agent-orchestrator_orch__context_pack` | 主控 |
| resume | `mcp__plugin_agent-orchestrator_orch__resume` | 主控 |

### 4.3 board

描述（双语要点）：持久任务板的增查。跨会话恢复的数据源。
inputSchema：

```json
{
  "type": "object",
  "properties": {
    "action": { "enum": ["upsert", "get", "list"], "description": "upsert=创建或按字段合并更新；get=按 id 取单条；list=按状态过滤列出" },
    "mission": {
      "type": "object",
      "description": "upsert 时的字段包，浅合并到既有记录（dispatch/blocked/pack 深一层合并）",
      "properties": {
        "id": { "type": "string", "description": "缺省自动生成 m-<YYYYMMDD-HHmmss>-<4hex>" },
        "title": { "type": "string" },
        "original_prompt": { "type": "string", "description": "派发任务原文，跨会话恢复的关键" },
        "agent_type": { "type": "string", "description": "如 agent-orchestrator:orch-worker" },
        "model": { "type": ["string", "null"] },
        "status": { "enum": ["drafted", "dispatched", "running", "blocked", "question", "done", "failed", "resumed", "closed"] },
        "dispatch": {
          "type": "object",
          "properties": {
            "mode": { "enum": ["agent", "workflow"] },
            "agent_id": { "type": ["string", "null"], "description": "agent_<uuid>" },
            "task_id": { "type": ["string", "null"], "description": "后台任务 id" },
            "run_id": { "type": ["string", "null"], "description": "workflow run id" },
            "run_in_background": { "type": "boolean" },
            "session_id": { "type": ["string", "null"], "description": "派发会话 id（来自 SessionStart 注入）" },
            "token": { "type": "string", "description": "8hex 派发令牌" }
          }
        },
        "pack": { "type": "object", "properties": { "path": { "type": "string" }, "variants": { "type": "array", "items": { "type": "string" } } } },
        "artifacts": { "type": "array", "items": { "type": "object", "properties": { "path": { "type": "string" }, "note": { "type": "string" } } } },
        "output_files": { "type": "array", "items": { "type": "string" }, "description": "完成通知给出的输出文件路径（TaskOutput 失效时的兜底）" },
        "blocked": {
          "type": "object",
          "properties": {
            "question": { "type": ["string", "null"] },
            "asked_at": { "type": ["string", "null"] },
            "answered": { "type": "boolean" },
            "answer": { "type": ["string", "null"] },
            "answered_at": { "type": ["string", "null"] }
          }
        }
      }
    },
    "mission_id": { "type": "string" },
    "filter_status": { "type": "array", "items": { "type": "string" } }
  }
}
```

行为：`upsert` 自动盖 `updated_at` 并向 `timeline` 追加 `{at, event:"upsert", summary: status 变更}`；status 变为 done/failed/closed 时不动 spool。`list` 默认排除 closed，按 updated_at 倒序。返回完整 mission 对象或数组。

### 4.4 report（子代理专用上报）

inputSchema：

```json
{
  "type": "object",
  "required": ["mission_id", "worker", "kind", "summary"],
  "properties": {
    "mission_id": { "type": "string" },
    "worker": { "type": "string", "description": "worker 名，如 orch-worker#2" },
    "token": { "type": "string", "description": "派发包里的三行契约令牌" },
    "kind": { "enum": ["milestone", "blocked", "question", "done"] },
    "summary": { "type": "string", "maxLength": 200 },
    "details": { "type": "string", "description": "可选长文/结论" },
    "artifacts": { "type": "array", "items": { "type": "string" } },
    "question": { "type": "string", "description": "kind=blocked/question 时必填的提问" },
    "urgent": { "type": "boolean", "description": "仅标记，直答仍走 SendMessage/RespondToCoordinator" }
  }
}
```

行为：校验 mission 存在；若 board 记录了 `dispatch.token` 且传入 token 不符 → isError（防误报）。生成事件文件写入 `spool/<mission_id>/unread/`（文件名=`String(Date.now()).padStart(15,"0")` + `-` + `randomBytes(4).toString("hex")` + `.json`，字典序=时间序）。服务端联动 board：kind=done → status=done；kind=blocked/question → status 同名 + `blocked.question/asked_at`。返回 `{ok, event_id, spool_path, hint}`（hint 提醒：主控轮询邮箱，紧急才用 RespondToCoordinator）。summary 超 200 → 截断并在返回中注明。

### 4.5 mailbox（主控邮箱）

inputSchema：

```json
{
  "type": "object",
  "properties": {
    "action": { "enum": ["peek", "read", "answer", "gc"] },
    "mission_id": { "type": "string" },
    "kind": { "enum": ["milestone", "blocked", "question", "done"] },
    "limit": { "type": "number", "default": 20 },
    "answer": { "type": "string", "description": "action=answer 时必填" },
    "keep_days": { "type": "number", "default": 14, "description": "gc 阈值" }
  }
}
```

行为：
- `peek`：不消费。返回每条 unread 的 `{event_id, mission_id, worker, kind, summary, age_ms}` + 每个 mission 的"最老事件 age_ms"（沉默检测）。
- `read`：按 mission_id/kind 过滤，逐条 `renameSync(unread→read)` 原子消费，返回完整 payload 数组。
- `answer`：需要 `mission_id`+`answer`。写 `answers/<seq>-answer.json`；更新 board（`blocked.answer/answered/answered_at`，status 回 `dispatched`，timeline 追加）；返回 `{ok, recommended_call: {tool:"SendMessage", to:<agent_id>, summary:"≤200字答复", message:"<answer> + 继续指令模板"}, note:"运行中=steer；已终态=后台恢复续聊；跨会话/无 agentId=用 context_pack 重建后重新派发"}`。
- `gc`：删除 read 下早于 keep_days 的事件；把 board 中 closed missions 移入 `archive/board-<ts>.json` 并从主文件剔除。

### 4.6 spawn_agent（运行时自定义角色）

inputSchema：

```json
{
  "type": "object",
  "required": ["name", "description"],
  "properties": {
    "name": { "type": "string", "pattern": "^[a-z0-9][a-z0-9-]{0,63}$" },
    "description": { "type": "string", "minLength": 10 },
    "archetype": { "enum": ["worker", "scout", "reviewer"], "default": "worker" },
    "model": { "type": "string", "description": "providerId/modelId；缺省=继承会话模型" },
    "max_turns": { "type": "number" },
    "tools": { "type": "array", "items": { "type": "string" }, "description": "覆盖原型工具面；必须保留 report 全名" },
    "system_prompt": { "type": "string", "description": "追加在原型正文后的角色专述" },
    "overwrite": { "type": "boolean", "default": false }
  }
}
```

行为：目标 `<项目>/.zcode/agents/<name>.md`（路径包含校验）。服务器内嵌三个 archetype 模板（frontmatter+正文骨架+§6 的协议块原样烧入）；`model` 有值才写 `model:` 行；已存在且未 overwrite → isError。返回 `{path, registered_as:"<name>", note:"项目级 agent 在新会话注册；当前会话请用 Agent(prompt=原型正文+system_prompt) 注入 persona 替代"}`。

### 4.7 context_pack（物化上下文包 / 分叉）

inputSchema：

```json
{
  "type": "object",
  "required": ["mission_id", "title", "task"],
  "properties": {
    "mission_id": { "type": "string" },
    "title": { "type": "string" },
    "task": { "type": "string" },
    "read_first": { "type": "array", "items": { "type": "string" } },
    "rules": { "type": "array", "items": { "type": "string" } },
    "return_format": { "type": "string" },
    "upstream_context": { "type": "string", "description": "上游产物逐字注入（子代理当时不在场）" },
    "variants": { "type": "number", "minimum": 1, "maximum": 8, "default": 1 },
    "variant_axes": { "type": "array", "items": { "type": "string" }, "description": "每个变体的差异维度，长度建议=variants" },
    "extra": { "type": "string" }
  }
}
```

行为：按 §7.3 模板合成 pack.md（variants>1 → pack-v1..vN，每份多一节 VARIANT）；原子写入 `packs/<mission_id>/`；board.upsert 记录 `pack.path/variants`；生成 8hex token 写入 `dispatch.token`（已有则沿用）。返回 `{pack_paths, token, channel: mission_id, prompt_template}`——prompt_template 即三行契约派发头（§7.3），主控逐字粘贴进 Agent prompt。

### 4.8 resume（恢复简报）

inputSchema：`{"type":"object","properties":{"session_id":{"type":"string","description":"当前会话 id，用于区分同会话/跨会话"}}}`
行为：读 board+spool（unread 计数），为每个未 closed mission 计算 `recommended_action`：

| 条件 | recommended_action |
|---|---|
| dispatch.mode=workflow 且 run 记录 stopped | `ResumeWorkflowRun(run_id)` |
| workflow errored | `AmendWorkflow(run_id, path=scriptPath)`（勿重写） |
| workflow 其余 | `GetWorkflowRun(run_id)` 查状态/pendingQuestions |
| mode=agent 且 dispatch.session_id == 入参 session_id 且已终态 | `SendMessage(to=agent_id, ...)` 恢复续聊 |
| mode=agent 且跨会话（session_id 不同或为空） | `context_pack` 重建 + 重新派发（agentId 跨会话无效） |
| blocked.answered == false | `mailbox(read)` → `mailbox(answer)` |
| status=done 未 closed | 聚合产物 → `board(upsert, status="closed")` |

返回 `{generated_at, session_id, missions:[...], unread_total, actions_top3}`。无 board 时返回空简报（isError=false）。

## 5. 数据格式（字段级）

### 5.1 board.json

```json
{
  "version": 1,
  "updated_at": "2026-10-12T15:30:45.000Z",
  "missions": [
    {
      "id": "m-20261012-153045-a1b2",
      "title": "三个状态库选型调研",
      "original_prompt": "用户原话/派发任务全文（跨会话恢复的种子）",
      "agent_type": "agent-orchestrator:orch-scout",
      "model": null,
      "status": "blocked",
      "dispatch": {
        "mode": "agent", "agent_id": "agent_9f2c…", "task_id": "bg_01J…",
        "run_id": null, "run_in_background": true,
        "session_id": "sess_ab12…", "token": "8位hex",
        "dispatched_at": "ISO"
      },
      "pack": { "path": ".zcode/orchestrator/packs/m-…/pack.md", "variants": [] },
      "artifacts": [{ "path": "reports/zustand.md", "note": "调研报告" }],
      "output_files": ["<完成通知给出的输出文件路径>"],
      "blocked": { "question": "目标 Node 版本按 18 还是 20？", "asked_at": "ISO",
                   "answered": false, "answer": null, "answered_at": null },
      "timeline": [{ "at": "ISO", "event": "report:blocked", "summary": "≤200字" }],
      "updated_at": "ISO"
    }
  ]
}
```

状态机：`drafted → dispatched → (running|blocked|question|done|failed)`；`blocked/question →(answer) dispatched/resumed`；`done/failed → closed`；workflow stopped 标 `resumed` 后继续用 running/done。

### 5.2 spool 事件文件

文件名：`<15位零填充epochMs>-<8hex>.json`（字典序=时间序；消费=`renameSync(unread→read)`）。

```json
{
  "v": 1,
  "id": "000 protocol中=event_id（文件名去 .json）",
  "at": "ISO",
  "mission_id": "m-…",
  "worker": "orch-scout#1",
  "agent_id": "agent_…|null",
  "token": "8hex",
  "kind": "milestone|blocked|question|done",
  "summary": "≤200字",
  "details": "可选长文",
  "artifacts": ["相对/绝对路径"],
  "question": "kind∈{blocked,question} 时的提问",
  "urgent": false
}
```

## 6. agents 规格（自带 3 角色）

注册名 `agent-orchestrator:<bareName>`；裸名带 `orch-` 前缀防撞。**均不写 `model`**（默认继承会话模型；模型绑定靠 spawn_agent 变体，见 §7.6 三级选择）。三个角色正文都必须原样烧入"协议块"：三行契约说明、report 工具全名与 kind 枚举（summary≤200）、上报边界（"超出能力范围/目标矛盾/必败门禁 → 立即 report blocked，不硬扛不造假"）、禁止事项（Task/Skill/邮箱消费工具/AskUserQuestion，强制星型拓扑）。

### 6.1 `agents/orch-worker.md`（执行型）

```yaml
---
name: orch-worker
description: "执行型子代理：在主控派发的上下文包内完成编码/构建/修测任务，用 report 工具按 kind=milestone/blocked/question/done 汇报进度与阻塞。任何需要动手改代码并回报进度的派发都用它；不要用它做纯只读调研（用 orch-scout）或评审（用 orch-reviewer）。"
color: cyan
tools: [Read, Write, Edit, Glob, Grep, Bash, WebSearch, WebFetch, mcp__plugin_agent-orchestrator_orch__report]
disallowedTools: [Task, Skill, AskUserQuestion, mcp__plugin_agent-orchestrator_orch__mailbox, mcp__plugin_agent-orchestrator_orch__board, mcp__plugin_agent-orchestrator_orch__spawn_agent, mcp__plugin_agent-orchestrator_orch__context_pack, mcp__plugin_agent-orchestrator_orch__resume]
---
```

正文要点：① 开工协议：先 Read 派发包；缺包/读不到 → `report(kind=blocked)` 而不是瞎猜。② 汇报协议：每完成一个可验收单元发 milestone；全部完成发 done（artifacts 必带路径）；受阻即发 blocked（question 写清要什么决策）。③ 紧急四情形（验收标准要变 / 继续做已无意义 / 需不可逆操作 / 阻塞超 10 分钟）且主控曾发来消息（`RespondToCoordinator` 工具出现时）→ 直达主控；否则一律走 report。④ 收到主控消息：按指示继续或修正，可短回复。⑤ Return 格式：做了什么（3-6 条）+ 产物路径 + 遗留问题。

### 6.2 `agents/orch-scout.md`（只读调研型）

```yaml
---
name: orch-scout
description: "只读调研子代理：查代码/文档/网络，产出带证据（path:line 或引用）的结论，不改任何文件。用于主控派发的调研、查证、选项比较；结论经 report 工具回报。需要它动手改代码时改用 orch-worker。"
color: blue
tools: [Read, Glob, Grep, WebSearch, WebFetch, mcp__plugin_agent-orchestrator_orch__report]
disallowedTools: [Write, Edit, MultiEdit, NotebookEdit, Bash, Task, Skill, AskUserQuestion, mcp__plugin_agent-orchestrator_orch__mailbox, mcp__plugin_agent-orchestrator_orch__board, mcp__plugin_agent-orchestrator_orch__spawn_agent, mcp__plugin_agent-orchestrator_orch__context_pack, mcp__plugin_agent-orchestrator_orch__resume]
---
```

正文要点：结论必须带证据引用；不跑命令（需要跑命令的调研用 spawn_agent 造 worker 变体）；中期发现发 milestone、最终报告发 done（details=结论全文，artifacts=引用清单或落盘报告路径）；同 §6.1 协议块。

### 6.3 `agents/orch-reviewer.md`（评审型）

```yaml
---
name: orch-reviewer
description: "评审子代理：对指定文件/diff/交付物做验收评审，可运行测试与检查命令，但绝不修改文件；产出逐条问题（位置+证据+严重度）与总体 verdict，经 report 工具回报。用于质量门禁、验收、方案批判。"
color: yellow
tools: [Read, Glob, Grep, Bash, WebSearch, WebFetch, mcp__plugin_agent-orchestrator_orch__report]
disallowedTools: [Write, Edit, MultiEdit, NotebookEdit, Task, Skill, AskUserQuestion, mcp__plugin_agent-orchestrator_orch__mailbox, mcp__plugin_agent-orchestrator_orch__board, mcp__plugin_agent-orchestrator_orch__spawn_agent, mcp__plugin_agent-orchestrator_orch__context_pack, mcp__plugin_agent-orchestrator_orch__resume]
---
```

正文要点：逐条问题格式 `{where, what, evidence, severity(low|medium|high)}`；"要求审批的评审要找会坏什么，不是问好不好"；能跑的确定性检查必须真跑（Bash），没跑的标 unverified；同 §6.1 协议块。

## 7. SKILL.md 规格（插件的心脏）

### 7.1 frontmatter

```yaml
---
name: agent-orchestrator
description: "主控操作手册：把主控 agent 变成任务指挥官。当需要（a）派发/并行/分叉多个子代理并持续跟踪；（b）子代理后台跑、主控同时继续别的活；（c）子代理阻塞提问、主控作答后让它继续；（d）同会话或跨会话恢复中断的任务；（e）给不同子代理/角色选不同模型；（f）运行时创建自定义角色——任一情况都使用本技能。含三行契约派发、任务板与邮箱轮询、SendMessage 恢复与 steer、ResumeWorkflowRun/AmendWorkflow、Stop 收工提醒处置。"
---
```

（≤1024 字符，含触发条件，满足。）

### 7.2 章节大纲与每章要点

1. **何时用 + 概念图**：主控/任务板(board.json)/邮箱(spool)/三行契约一图流；"主控是唯一轮询者与答题者"。
2. **标准派发七步**：① `board(upsert)` 建 mission（original_prompt 必填）→ ② `context_pack` 生成包+token → ③ `Agent(subagent_type="agent-orchestrator:orch-worker", prompt=prompt_template+任务原文, run_in_background=true)` → ④ `board(upsert, dispatch={agent_id,task_id,session_id})` → ⑤ **不等**：继续别的活（同消息多条 Agent=并发，≤8）→ ⑥ 完成通知到达后：读输出文件路径（兜底）+ `mailbox(read)` 消费事件 → ⑦ 聚合落盘（结果写文件，只摘要进上下文）+ `board(upsert, status="closed")`。
3. **派发包模板**：§7.3 原文照录（三行契约 + CONTEXT 逐字注入 + READ FIRST + TASK + RULES + VARIANT + RETURN + ESCALATION）。
4. **状态→动作决策表**：§7.4 全表。
5. **提问-回答-恢复闭环**：常规 `report(blocked)` → 主控 `mailbox(peek/read)` → **可先派 orch-scout 查证再答** → `mailbox(answer)` 拿 recommended_call → `SendMessage(to, summary, message)`（运行中=steer 注入；已终态=后台恢复，可反复）；紧急四情形走 `RespondToCoordinator` 直达；workflow：子代理 `escalate` → dwfq-id 通知 → `ResolveWorkflowQuestion(question_id, answer)`（答题期间 run 其余照常；dwfq 无超时，**不能放着不答**）；通知丢失兜底 `GetWorkflowRun` 看 `pendingQuestions`；脚本本身坏了 → 改 script 文件 + `AmendWorkflow(path)`。
6. **后台并行纪律**：run_in_background 为默认；多条 Agent 放同一消息；不轮询、靠完成通知；`TaskOutput(task_id, block=true, timeout≤600000)` 仅作显式等待且偶发 "No task found" → 兜底=完成通知里的输出文件路径 / `GetWorkflowRun`/`ListWorkflowRuns`；`TaskStop(task_id)` 收敛失控任务。
7. **恢复手册**：同会话=SendMessage；workflow=决策树（stopped→ResumeWorkflowRun；errored→AmendWorkflow 修 path；superseded→看 successor 勿恢复；provider 停→按错误提示解决后续跑；user 停→除非用户要求不动）；跨会话=`resume` 工具出简报 → 按 recommended_action：能 SendMessage 的恢复，不能的 context_pack 重建 + 新派发（agentId 跨会话无效）。
8. **分叉模式**：2–8 个独立变体、一轮出结果 → `context_pack(variants=N, variant_axes=[...])` + 同消息 N 条 Agent；需要循环/门禁/结果互联 → CreateWorkflow fan-out（注意：模型可按子代理在 persona 指定——`agent(name, { system?, model? })`，未指定继承 run 级 `subagent_model`；工具面仍全局同一、无 per-agent 工具集，角色=persona(system+model)）；结果比较 → 派 orch-reviewer 汇总。
9. **模型选择两轨**：普通 Agent 轨（三级不变）：① 用户显式指定（先 `ListModels` 校验 id，`disabledReason` 非空则换）→ ② 角色绑定（`spawn_agent(model=...)` 造 `orch-worker-<tag>`，一角色一模型）→ ③ 默认继承会话模型。workflow 轨（三种粒度，优先级 persona.model > run 级 `subagent_model` > 会话模型）：① 脚本内 per-agent——`agent(name, { model })` 的 model 取编译期字符串字面量（`"modelId"`/`"providerId/modelId"`，可带 `$reasoningLevel` 如 `"GLM-5.3$high"`）或 `model("…")` 返回的 ModelRef（声明表置顶，运行期只能在已声明 ModelRef 之间选择；agent() 创建时冻结，ask() 签名未变），模型表放脚本顶部、一处 amend 全局生效；② run 级 `subagent_model`（settings-only 改=停旧开新，仅 max_concurrency 可 in-place）；③ 未指定者继承会话模型。无"运行中动态改单个子代理模型"的 API，唯一路径=改脚本里的模型字面量/表 → `AmendWorkflow(path)`（supersede 旧 run，已完成工作零成本导入；缓存匹配显式剥离 persona 的 model 字段——改某子代理模型不冲掉它的缓存，但缓存命中的已完成 ask 仍返回旧模型结果，仅新 live ask 跑新模型）。启动期校验：脚本中所有模型名对照 host 模型目录解析（modelBindings 记 journal）并经用户确认窗口批准，host 无模型目录则拒绝启动；诊断码 9010=编译期 model 值非法（非字面量/字面量联合/ModelRef、动态拼名，提示 as const）、9011=解析失败（not_found/ambiguous/disabled/reasoning_level_unknown，提示 `ListModels` 或改用全 providerId/modelId）。使用纪律（官方口径）：仅当用户要求或明显轻量层（judge/router）时用 per-agent 模型，id 一律取自 ListModels。
10. **自定义角色**：`spawn_agent` 参数映射、三 archetype 表、生效时机（新会话注册；当前会话用 Agent prompt 注入 persona 替代）、转正（临时代理用得好 → spawn_agent 固化，借鉴 mbruhler）。
11. **Stop 提醒处置**：收到 Stop hook 注入清单 → 逐项处置（能 close 的 close、blocked 的答、unread 的读）；确实收工则处置完再停；`stop_hook_active=true` 时平台将放行，不要依赖无限提醒。
12. **坑位清单**：无 SubagentStop/PreCompact；hook payload 不区分子代理身份；Agent 工具无 model 参数；普通子代理无 SendMessage/提问工具（上行=RespondToCoordinator[需主控先发过消息] 与终态返回）；SendMessage summary≤200、message≤20000；`${ARGUMENTS}` 不被命令替换（用 `$ARGUMENTS`）；聚合全文进上下文=膨胀首因；子代理互调禁止；单会话并发≈8；SaveWorkflow 需用户同意；`ResumeWorkflowRun` 对 errored/completed/superseded 无效；workflow 脚本内模型名必须是编译期字面量或 ModelRef，动态拼名触发 9010（提示 as const）；FillWorkflowHole 的 body 不能引入 run 未绑定的新模型（9011，需 `AmendWorkflow`）；改模型不清缓存，但缓存命中的旧 ask 仍返回旧模型结果（新 live ask 才跑新模型）。
13. **快速参考**：6 个工具全名表、kind 枚举、状态机、平台编排原语速查（§10）。

### 7.3 派发包模板（SKILL 与 context_pack 共用，逐字）

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

派发 prompt 头（context_pack 返回的 prompt_template）：

```
[channel] {mission_id}
[worker] {worker-name}
[token] {token}
You are working on: {title}. 先 Read 任务包 {pack_path}，按包内 TASK/RULES 执行；用 mcp__plugin_agent-orchestrator_orch__report 汇报（kind ∈ milestone/blocked/question/done）。Return：做了什么+产物路径+遗留问题。
```

### 7.4 状态→动作决策表（SKILL 全文收录）

| 观测 | 来源 | 主控动作 |
|---|---|---|
| dispatched，无完成通知 | board | 继续别的活，不轮询 |
| 完成通知到达 | 通知 | 读输出文件路径 → `mailbox(read)` 消费 → 聚合落盘 → mission closed |
| running 且最老事件 age_ms>15min | `mailbox(peek)` | `SendMessage(steer)` 询问进度；无 agentId → 派 scout 查证 |
| kind=blocked/question | `mailbox(read)` | 能答→`mailbox(answer)`+SendMessage；需查证→先派 orch-scout；workflow→`ResolveWorkflowQuestion(dwfq-id)` |
| done | report/board | 聚合 → closed |
| workflow errored | 通知 | 读错误 → 改 script 文件 → `AmendWorkflow(path)`（勿 CreateWorkflow 重写） |
| workflow stopped=user | 通知 | 除非用户要求，不动 |
| stopped=provider | 通知 | 按 `<error>` 修复 → `ResumeWorkflowRun(run_id)` |
| stopped=interrupted | 通知 | `ResumeWorkflowRun(run_id)` |
| superseded | — | 勿恢复，看 successor |
| Stop 注入清单 | Stop hook | 逐项处置后收工 |
| `TaskOutput` "No task found" | TaskOutput | 用完成通知输出文件路径；或 `GetWorkflowRun`/`ListWorkflowRuns` |

## 8. commands 规格（5 个）

| 文件 | frontmatter | 正文要点 |
|---|---|---|
| `orch.md` | `description: "总控台：任务板+邮箱+workflow 待答问题一览"`；`argument-hint: "[mission_id]"` | 依次调 `board(list)`、`mailbox(peek)`、有 run_id 则 `GetWorkflowRun` 看 pendingQuestions；输出状态表；对每项按 SKILL 决策表给建议动作；只建议不执行，等用户选。`$1` 过滤单个 mission。 |
| `orch-spawn.md` | `description: "创建自定义子代理角色（写入项目 .zcode/agents）"`；`argument-hint: "<名称> <描述> [archetype] [model]"` | 解析 `$ARGUMENTS`/`$1..$4`；调 `spawn_agent`（archetype 缺省 worker；model 建议先 `ListModels` 校验）；展示写入路径、"新会话生效、当前会话用 persona 注入替代"提示。 |
| `orch-resume.md` | `description: "恢复中断任务：本会话续聊 / workflow 续跑 / 跨会话接力"`；`argument-hint: "[mission_id]"` | 调 `resume`；按 recommended_action 逐项执行（SendMessage / ResumeWorkflowRun / AmendWorkflow / context_pack+重派）；每项执行后 `board(upsert)` 更新状态；最后汇报处置清单。 |
| `orch-fork.md` | `description: "把一个任务分叉为 N 个并行变体"`；`argument-hint: "<N> <任务描述>"` | `$1`=N（默认 3）；`$ARGUMENTS` 其余为任务；`context_pack(variants=N, variant_axes=从任务推导或追问用户)`；同一消息发 N 条 `Agent(run_in_background=true)`；board 记录；提醒等待纪律与完成通知处置。 |
| `orch-model.md` | `description: "查看/绑定子代理模型（角色一模型）"`；`argument-hint: "[角色名] [providerId/modelId]"` | 无参→`ListModels` 列表+说明两轨选择（普通 Agent 三级 / workflow 三粒度）；有参→`ListModels` 校验 id（disabledReason 非空要提示；歧义/解析失败时改用全 `providerId/modelId`）后输出三类：① `spawn_agent(name=<角色>-<tag>, model=…, overwrite=true)`；② workflow run 级 `subagent_model` 用法；③ workflow 脚本内 per-agent 用法示例——`agent(name, { model: "providerId/modelId" })` 或脚本顶部 `const M = { strong: model("…") }` 表 + `agent(name, { model: M.strong })`（注明字面量/ModelRef 约束、启动校验经确认窗口批准、9010/9011）。 |

命令名合法性：均匹配 `^[a-z0-9][a-z0-9_:-]{0,63}$`；正文用 `$ARGUMENTS`/`$1`（不用 `${ARGUMENTS}`）。

## 9. hooks 规格

### 9.1 `hooks/hooks.json`（原文）

```json
{
  "description": "agent-orchestrator lifecycle hooks: cross-session resume notice and stop-time accountability.",
  "hooks": {
    "SessionStart": [
      {
        "hooks": [
          {
            "type": "process",
            "command": "node",
            "args": ["${ZCODE_PLUGIN_ROOT}/hooks/session-start.mjs"],
            "timeoutMs": 10000,
            "statusMessage": "检查可恢复的任务板…"
          }
        ]
      }
    ],
    "Stop": [
      {
        "hooks": [
          {
            "type": "process",
            "command": "node",
            "args": ["${ZCODE_PLUGIN_ROOT}/hooks/stop-check.mjs"],
            "timeoutMs": 10000,
            "statusMessage": "清点未竟任务与邮箱…"
          }
        ]
      }
    ]
  }
}
```

### 9.2 `hooks/session-start.mjs`（SessionStart）

- stdin 收 JSON（含 `hook_event_name, session_id`；环境变量含 `ZCODE_PROJECT_DIR`）。定位根：先读 `<ZCODE_PROJECT_DIR>/.zcode/orchestrator/root.txt` 指针（存在则用其指向的自定义根），否则默认目录本身。
- 扫 board：resumable = status ∈ {dispatched, running, blocked, question} 或 `blocked.answered===false`；数各 mission unread。
- 无可恢复 → `exit 0` 静默。有 → 输出并 `exit 0`：

```json
{"additionalContext": "[agent-orchestrator] 检测到可恢复任务：\n- [m-…] 三个状态库选型调研｜blocked｜orch-scout｜原任务：用户原话前60字…\n未读邮箱事件 2 条。\n本会话 session_id=<session_id>（派发时请记入 board）。执行 /orch-resume 或调用 mcp__plugin_agent-orchestrator_orch__resume 获取接力计划。"}
```

- 任何异常（board 损坏/无权限）→ `exit 0` 静默；总输出 ≤1500 字符；绝不允许非 JSON 进 stdout。

### 9.3 `hooks/stop-check.mjs`（Stop）

- stdin 含 `stop_hook_active`。**若 `stop_hook_active === true` → 直接 exit 0 无输出**（已提醒过一次，放行收工，尊重平台最多续 3 次的上限）。
- 扫描 board（running/blocked/question/dispatched 未闭环）+ spool（unread 计数）+ board 中 `blocked.answered===false`。
- 无未竟 → exit 0 静默。有 → 输出并 exit 0：

```json
{"hookSpecificOutput": {"hookEventName": "Stop", "additionalContext": "[agent-orchestrator] 收工前清点：任务板尚有 2 项未竟（m-… blocked 待答：『Node 18 还是 20？』；m-… running 沉默 22 分钟），邮箱 1 条未读。处置：能答的 mailbox(answer)+SendMessage；能关的 board(upsert,status=closed)；确实收工请先逐项处置或显式关闭。详见 /orch。"}}
```

- 设计意图：文件事件本无唤醒通道，Stop 是主控唯一的"收工闸门"——在这里把未竟事项注入回去（超越 zcode-agent-comms 的局限）。

## 10. 平台编排原语速查（SKILL 第 13 章收录，主控引用）

- `Agent {description, prompt, subagent_type, run_in_background}`；无 model 参数；同步返回含 `agentId`（agent_<uuid>）；多条放同一消息=并发。
- `SendMessage(to=agent_<uuid>, summary≤200, message≤20000)`：终态=后台恢复续聊（可反复）；运行中=steer。
- `TaskOutput(task_id, block, timeout≤600000)`；`TaskStop(task_id)`。
- workflow：`CreateWorkflow{script|saved|path, name, max_concurrency, subagent_model}`、`AmendWorkflow{run_id, path|script, subagent_model, max_concurrency}`（任何状态可改，旧完成工作导入为缓存）、`ResumeWorkflowRun{run_id}`（仅 stopped）、`GetWorkflowRun`（pendingQuestions）、`ListWorkflowRuns{statuses}`、`ResolveWorkflowQuestion{question_id(dwfq-…), answer}`、`EvalWorkflowSnippet`、`ListModels`、`SaveWorkflow`（需用户同意）。子代理 `escalate` 每 ask 限 3 次。模型：可按子代理在 persona 指定——`agent(name, { system?, model? })`，model 取编译期字面量（可带 `$reasoningLevel`）或 `model("…")` 的 ModelRef，id 取自 `ListModels`；未指定继承 run 级 `subagent_model`；启动期模型名对照 host 模型目录校验并经确认窗口批准；诊断码 9010（编译期 model 值非法）/9011（解析失败，含 fill 引入 run 未绑定的新模型）；工具面仍全局同一、无 per-agent 工具集。
- hooks 仅 7 事件；Stop 的 `hookSpecificOutput.hookEventName="Stop"` + additionalContext 注入；退出码 0 放行。

## 11. 验收示例（用户一句话 → 主控应有行为序列）

1. **"并行调研 A、B、C 三个库的优劣"** → 建板 m-1 → context_pack(3 份 scout 包，task 各指一库) → 同消息 3×Agent(orch-scout, run_in_background) → board 记 3 个 dispatch → 继续别的活 → 3 条完成通知后 mailbox(read) → 汇总成报告落盘 → 3 mission closed。
2. **"用 3 种方案实现登录页再挑最好的"** → context_pack(variants=3, variant_axes=["方案一：表单库 X","方案二：手写","方案三：组件库 Y"]) → 3×orch-worker 并行 → 完成后派 orch-reviewer 评审三产物 → 向用户给 verdict。
3. **"这个跑 GLM，那个跑别的模型"** → workflow 同一 run 多模型并存：脚本顶部建 model 表（`const MODELS = { glm: model("…"), alt: model("…") }`，id 经 `ListModels` 校验、启动确认窗口批准），各子代理 `agent(name, { model: MODELS.glm })` 指定、未指定继承 `subagent_model`；A/B 对比=先全轻模型跑完 → 改表中关键子代理的模型 → `AmendWorkflow(path)` 换强模型：已完成工作免费保留（缓存命中出旧结果），仅新 live ask 跑新模型。
4. **会话中断后重开："继续上次的事"** → SessionStart hook 注入简报 → /orch-resume → resume 工具列 missions → workflow stopped 的 ResumeWorkflowRun；blocked 的先答再 SendMessage/重派 → board 更新。
5. **子代理 blocked："目标 Node 版本按 18 还是 20？"** → report(blocked) 落邮箱 → 主控 mailbox(read) → 不确定则派 orch-scout 查项目约束 → mailbox(answer, answer="按 18，因为 CI 锁 18") → 按 recommended_call SendMessage(to=agent_id) → 子代理续跑 → done。
6. **主控想收工但有任务在飞** → Stop hook 注入清单 → 主控处置（答 blocked、关 done、留 running 并说明）→ 第二次 Stop 时 `stop_hook_active=true` 放行。

## 12. 冒烟测试计划

1. **静态**：`node -e "JSON.parse(...)"` 校验 plugin.json / .mcp.json / hooks.json（marketplace.json 由脚本生成后同样校验）；`node --check mcp/server.mjs hooks/session-start.mjs hooks/stop-check.mjs`。
2. **MCP 握手**（临时脚本，不入库）：子进程 `node server.mjs --root <临时目录>`，按行发：
   `initialize` → 断言回 protocolVersion/capabilities/serverInfo；`notifications/initialized` → 断言无输出；`tools/list` → 断言 6 个工具与全名前缀 `mcp__plugin_agent-orchestrator_orch__`；`ping` → 断言 `{}`；`{"method":"nope"}` → 断言 -32601；坏行 → 断言 -32700。
3. **tools/call 往返**（同一临时根）：`board(upsert)` → `board(get)` 字段一致；`report(kind=blocked)` → unread 出现事件文件且 board.status=blocked；`mailbox(read)` → 文件移入 read/ 且返回 payload；`mailbox(answer)` → answers 留痕 + board.answered=true + 返回 recommended_call；`context_pack(variants=3)` → 3 个 pack 文件 + prompt_template 含三行契约；`spawn_agent(name=demo-scout)` → `.zcode/agents/demo-scout.md` 生成且 frontmatter 可解析；`resume` → 返回 missions 与 actions_top3。
4. **hooks**：`echo '{"hook_event_name":"SessionStart","session_id":"s1"}' | node hooks/session-start.mjs`（有/无 board 两态断言）；Stop 两态 + `stop_hook_active:true` 静默断言；stdout 必须是单行合法 JSON。
5. **Windows 专项**：rename 目标已存在不抛；路径包含校验拒绝 `..` 逃逸；无网断言（代码评审：无 fetch/http import）。
6. **端到端（人工）**：在测试项目装插件，跑验收示例 1 与 5 各一遍。

## 13. 风险清单

| 风险 | 缓解 |
|---|---|
| spawn_agent 写的角色当前会话不注册 | 返回值与 SKILL 明示"新会话生效"，当前会话用 Agent prompt 注入 persona 替代 |
| 跨会话 agentId 失效，SendMessage 恢复不了 | 恢复=重建 pack+新派发；board 存 original_prompt/pack 正是为此 |
| Windows rename EPERM/目标已存在 | 唯一文件名 + 存在检查 + `-1` 后缀重试 |
| 多会话并发写 board.json 竞态 | 单写者（MCP 服务器）读-改-原子写；接受小窗口 last-write-wins |
| Stop hook 与平台 3 次上限打架 | stop_hook_active=true 即放行；清单一次给全 |
| TaskOutput 偶发 "No task found" | board.output_files 存完成通知路径作兜底 |
| board/packs 无限膨胀 | mailbox gc + archive 归档 closed missions（keep_days=14） |
| MCP 工具全名超长易拼错 | 全名表在 DESIGN/SKILL/agent 正文三处逐字收录；agents 用白名单+disallowed 双保险 |
| 绑定的 model id 失效/不可用 | /orch-model 与 SKILL 强制 ListModels 校验（含 disabledReason） |
| dwfq 提问被搁置导致 run 卡死 | SKILL 决策表"不能放着不答"+ GetWorkflowRun pendingQuestions 兜底 |
| hook 脚本拿不到自定义根 | root.txt 指针文件机制（§9.2） |
| 敏感配置不可输入 | 不用 sensitive userConfig |

## 14. 给编码子代理的落地清单（按序）

1. 建目录树（§2）；先写 plugin.json/.mcp.json（§3，逐字可用）。
2. 写 `mcp/server.mjs`：JSON-RPC 骨架 → 根解析+包含校验+原子写 → board 读写 → 六工具（§4.3–4.8 的 schema 逐字用）→ 内嵌三 archetype 模板。
3. 写两个 hook 脚本 + hooks.json（§9）。
4. 写三个 agent .md（§6：frontmatter 逐字，正文按要点扩写并烧入协议块）。
5. 写 SKILL.md（§7 大纲，13 章齐全，模板与决策表逐字收录）。
6. 写 5 个命令（§8）。
7. 跑 §12 冒烟 1–5；用 upsert 脚本生成 marketplace.json（§3.3）。
8. 自检：工具全名前缀一致、无 `${ARGUMENTS}`、无网络 import、所有 stdout JSON 严格、路径不逃逸。

平台红线重申：hooks 只有 7 事件（无 SubagentStop）；Agent 工具无 model 参数；普通子代理无 SendMessage；ResumeWorkflowRun 仅 stopped；SendMessage summary≤200/message≤20000；stdout JSON 不得有多余键；本插件任何代码不得发起网络请求。

---

## 15. v0.2 增量：ack/疑似唤醒失败/后台闸门

v0.2.0 的增量设计权威是 `designs/agent-orchestrator-v0.2-DESIGN.md`（工作区 designs/ 目录），本文其余章节描述 v0.1 基线。增量要点：

- **主控签收 ack + 疑似唤醒失败检测**：mission 新增只读 `ack {at, by, note}` 字段（answer/close 自动补签，`board(action="ack")` 显式打标，upsert 传入被剥离忽略）；终态（done/failed/blocked/question）且有 dispatch.agent_id 且未签收且非 workflow 模式的 mission，在 Stop 清单、SessionStart 简报、resume 与 /orch 中被标为"疑似唤醒失败"。board.json 根对象 version 标记升 2（仅标记，读方不校验），0.1.x 数据懒迁移、无损读写。
- **后台强制闸门**：新增 PreToolUse hook `hooks/bg-gate.mjs`（matcher `Agent|Task`），对前台（run_in_background 缺省/false）且疑似长任务（prompt 含行首 `[channel] ` 或长度 ≥600）的派发按 userConfig `background_gate`（remind|ask|off，默认 remind）处置；`background_gate_exempt_types`（默认 judge）做子串豁免；fail-open，v0.2 永不 deny。
- **手册硬纪律**：SKILL 第 2/4/5/6/11/12/13 章按增量设计逐字修订；/orch 与 /orch-resume 命令补疑似唤醒失败呈现。

---

## 16. v0.3 增量：lessons/唤醒哨兵/上下文镜像/P2-1

v0.3.0 的增量设计权威是 `designs/agent-orchestrator-v0.3-DESIGN.md`（rev.b，工作区 designs/ 目录），本文其余章节描述 v0.1 基线（v0.2 增量见 §15）。增量要点：

- **lessons 学习记忆（特性 A）**：新增 `<存储根>/memory/lessons.jsonl`（只增不重排、原子重写）与新 MCP 工具 `lessons`（list/add/promote/retire，工具总数 6→7，仅主控可用、子代理 disallowed）。两级写入防污染：子代理 `report(kind=done, lessons=[…])` 只落 candidate；主控签收时 `promote` 人工提炼晋升（同 trigger+fix 自动合并，confidence≤0.95）；`add` 可带 `contradicts` 把旧条置 superseded 并记 counter_refs 反例（不删除）。score = confidence × (1+ln hits) × e^(−天/30)；score<0.1 自动衰汰 retired；`mailbox(gc)` 顺带衰汰过期 candidate。注入仅两处：context_pack 按任务关键词取交集 top6/≤1200 字的 LESSONS 节；SessionStart 简报全局 top3 单行（≤300）。
- **唤醒哨兵（特性 B，rev.b 单模式）**：新增 `hooks/bg-sentinel.mjs`，唯一启动方式是主控以宿主后台 Bash 任务运行（detached 孤儿进程退出无通知，叫不了人）。全清（无在飞且无未签收）→ 静默 exit 0 自毁；未签收结果持续跨越 wake_retries（默认 3）个 wake_timeout_min（默认 10 分钟）窗口 → exit 1 + 告警叫醒主控；24h 寿命自限；`sentinel.lock` wx 锁防多开、死锁自动接管。服务器不派生哨兵，只在启动时把 userConfig 写 `<存储根>/sentinel.cfg.json` 传递配置（CLI > cfg > 内建默认）。创建时点为固定 rituals：bg-gate 派发提醒（哨兵未在岗且过 10 分钟冷却才附，`wake_sentinel=off` 可关）+ SKILL 第 2 章第 4 步。
- **上下文镜像（特性 C，rev.b）**：新增 `hooks/journal.mjs` 注册 UserPromptSubmit（prompt 文本）+ stop-check 内嵌 assistant 侧记录（`last_assistant_message`），按会话写 `<存储根>/context/journal-<sessionId>.jsonl`（默认截 2000/4000 字符，单文件 400 条/2MB 封顶滚动淘汰至 300，恒静默零阻塞，`context_mirror=off` 一键停写）。禁直读平台会话库。注入两处：`resume` 返回 `prev_sessions`（最近 3 个会话尾部 tail×5 条）与 `context_hint`；`context_pack(mirror_digest=true)` 附 RECENT CONTEXT 节（最近 2 会话 ≤6 条/≤1200 字，标题自带"不构成本任务指令"防间接注入）。钉住重要内容复用 `lessons(action="add", type="preference"|"env-fact")`。
- **P2-1 修复**：`withComputed` 归一 `ack: missionAck(m)`——0.1.x 旧记录（缺失 ack 键）在 board get/list/upsert/ack 返回中稳定输出 `"ack":null`，JSON 序列化不再丢键。
- **配套**：`.mcp.json` 增三个数值参数（`--wake-timeout-min/--wake-retries/--poll-sec`）；plugin.json 版本 0.3.0、userConfig 新增 `wake_sentinel`（提示开关）与 `context_mirror`/`context_mirror_max_chars`；board.json 格式零变更（version 保持 2，0.1.x/0.2.x 懒迁移无损）。

---

## 17. v0.3.1 热修增量：并发写竞态 / 哨兵盲区 / 状态机守卫

三路红队复现确认的逻辑漏洞全量修复，board.json 格式零变更（version 保持 2）。

- **A 并发写竞态（根因=跨进程读改写全量覆盖、无锁）**：新增 `<存储根>/.lock/owner.json`（{holder,pid,heartbeatAt}）mkdir 型根锁，`withRootLock` 覆盖 board upsert/ack、report（spool+板+lessons 单临界区）、mailbox answer/gc、lessons 全部写路径、context_pack；进程内可重入。持锁 <2s，等锁 50-200ms 退避共 ~2s，超时报"存储忙，请重试"；锁龄>30s 或持锁 pid 死 → rename 式接管。`loadBoard` 对"文件不存在"先重读 3 次（间隔 50ms）再接受空板；`atomicWriteFileSync` 改 rename-only 重试循环（≥3 次失败才 unlink，unlink 后立即 rename 并二次校验）。answers 写盘 `flag:"wx"` 独占创建，冲突递增序号，杜绝覆盖。journal/stop-check 镜像改 `appendFileSync` 单行追加（seq 取尾窗 8KB、深窗口自适应超长行；滚动=超 2MB 时 rename 旧文件为 `.old` 后开新文件，不再整文件读改写）。
- **B 哨兵检测盲区与口径**：非 workflow 在飞（dispatched/running/resumed）龄期（timeline 末事件起算）≥ retries×timeout → exit 1 在飞龄期告警；board 连续 3 tick 不可读 → exit 1 "任务板不可读"；`sentinel.lock` 每 tick 心跳（heartbeatAt+mtime），接管判定=pid 死或心跳龄>90s，bg-gate 在岗判定同规则（治 PID 复用假在岗）；workflow 在飞排除出盯守集合，仅剩 workflow 时 exit 0 文案"workflow 托管中，其余已签收"；result_at 回退链 timeline→updated_at→board mtime→直接告警；cfg 每 tick 重读；elapsed 负值钳 0；remind/ask 路径哨兵句同受 `wake_sentinel` 开关控制；mailbox(read) 对 rename ENOENT（并发已消费）按已消费处理。
- **C 状态机守卫**：report(blocked/question) 重置 `blocked.answered/answer` 并清空旧 ack（二次提问重新可见）；stop-check/session-start 的 OPEN 集合补 `resumed`（bg-sentinel 原已含）；answer 仅 blocked/question 转 dispatched、终态 done/failed/closed 拒绝并提示（终态不可洗成在飞，running steer 保持原状态）；gc 顺带把过期未读归档进 read/（archived_unread_events），resume `unread_total` 与 Stop 清点口径统一（排除 closed）；closed mission 拒收改板类 report（事件仍入 spool、板不动、响应带 note），drafted 收 done 允许但带 warn；close 时存在未读/未答则响应附 warn（不阻止）。
- **Windows 平台事实（新）**：跨进程并发 rename 同一源路径可出现"幻影成功"（返回成功但源名仍可见，元数据延迟收敛）——`consumeEventFile` 改为移动后校验源已消失（未收敛则同 dst 重试，仍不收敛标记 `unresolved` 留给下一轮），mailbox(read) 全程持根锁，杜绝双投递。

---

## 18. v0.4 增量：沙箱派发 / 任务依赖图与自领取 / 主控并行迭代规程

v0.4.0 的增量设计权威是 `designs/agent-orchestrator-v0.4-DESIGN.md`（rev.a，工作区 designs/ 目录），本文其余章节描述 v0.1 基线（v0.2/v0.3/v0.3.1 增量见 §15/§16/§17）。增量要点：

- **沙箱派发 sandbox_dispatch（特性 1）**：`context_pack` 新增 `isolation`/`oob_allowlist`/`share_node_modules` 三参；isolation=worktree 时在根锁内 materialize git worktree 沙箱（`<存储根>/sandboxes/<mission_id>/`，分支 `orch/<完整 mission_id>`，node_modules junction 可共享、装依赖类自动禁用），任务包路径前缀改写并附 SANDBOX 节（红线声明+diff 存证要求）。新增 MCP 工具 `sandbox_apply`（门禁=done+qa.verdict=pass；主仓 porcelain 巡检+allowlist 越界机械检出+merge-tree 冲突预检（≥2.38）+干净 merge → worktree remove → board closed 自动签收；冲突 isError 附冲突清单与合并代理四件套指引，apply 失败零副作用）与 `sandbox_discard`（弃分支+强删 worktree，主仓零损伤，幂等）。工具总数 7→9，子代理 MCP_DISALLOWED 新增两项；git 子进程经 `node:child_process` 仅限本地 CLI，远端 argv（push/pull/fetch/clone/remote/submodule）静态红线。评审 verdict 落 mission.qa（ONE_LEVEL 深合并）。
- **任务依赖图+自领取（特性 2）**：mission 新增 `blockedBy`/`owner`/`claim`/`skippedReason`（懒迁移，BOARD_VERSION 保持 2）；状态机新增 `ready`（blockedBy 全 done/skipped/closed 自动解锁）与 `skipped`（任一上游 failed/skipped 级联，skippedReason=upstream_failed）终态；`sweepGraph` 定点扫描在每次 board 写事务内 fixpoint 执行（解锁/级联/租约回收/悬挂清理），无定时器。`board(action="claim", mission_id, worker, lease_minutes?)` 根锁内 CAS 自领取：成功即 running 并写租约（{worker, token, claimedAt, leaseUntil}）；worker 每次 report 自动续租（lease 缺省取 userConfig `claim_lease_min`=30），超时回 ready。blockedBy 成环 upsert 直接拒绝（DFS 检环，board 不落盘），允许前向引用。口径：ready 无人领取不算未竟、不触发哨兵/Stop/SessionStart；resume 返回 `ready_unclaimed(_count)` 并给领取建议；claim 领取即 running，进入既有在飞/唤醒体系。
- **主控并行迭代规程（特性 3）**：SKILL 16→19 章——第 17 章沙箱操作面（七步变体/冲突分支/三层检出矩阵）、第 18 章依赖与池工（spawn_agent tools 覆盖放行 board 的池工模式）、第 19 章多轮流水线规程（输入冻结判据/并发上限 8/独立 mission/聚合全文落盘/按 mission 签收恢复）。
- **配套**：plugin.json 版本 0.4.0、userConfig 新增 `sandbox_default`（none|worktree，默认 none）与 `claim_lease_min`（默认 30）；`.mcp.json` 增 `--sandbox-default`/`--claim-lease-min`；/orch 第 5 步与 /orch-resume 清单补沙箱收尾与 ready/skipped 处置行；stop-check OPEN_STATUSES 补口径注释（逻辑零改动）；board status enum 增 ready/skipped。
---

## 19. v0.4.1 增量：哨兵 v2 家族 / 转录收割 / 健壮性五件

v0.4.1 的增量设计权威是 `designs/agent-orchestrator-v0.4.1-DESIGN.md`（rev.b，工作区 designs/ 目录），本文其余章节描述基线与 v0.2–v0.4 增量（见 §15–§18）。增量要点：

- **哨兵 v2（直至型错峰冗余家族）**：bg-sentinel.mjs 整体重写——同命令连发 N 次（默认 3，userConfig `sentinel_family`）= N 个独立宿主后台任务互为冗余（一次退出=一枪，单进程只有一条命，多枪只能多实例）；槽位文件 `sentinel/instance-<k>.json`（wx 认领/心跳接管/满编静默让位/全清自毁）、fired 日志 wx 仲裁（错峰 refire_gap 5 分钟、cap_window 120 分钟封顶 3 枪、末枪 final=abandoned）、状态分级阈值（done 5 / blocked-question 3 / 在飞失联 30 / 崩溃实锤 10 分钟，C3 绕过双空闲门）、双空闲门（主控活跃主信号=tool_usage 只读、副=rollout、三=journal、四=board mtime，全缺失按空闲；逃逸口 2×宽限硬保证）、崩溃检测（rollout model-io 心跳 + tool_usage 佐证；node:sqlite 动态探测失败降级 ×3 保守档）、回声三通道（本地 echo.jsonl + 平台邮箱六字段信封（写前自校验+tmp+rename 毒丸规避）+ abandoned OS toast 兜底）；board 绝对只读（自有落盘全在 sentinel/）。0.3.1 参数桥：refire_gap←wake_timeout_min、cap←wake_retries。
- **server 配套**：sentinel.cfg.json 发布 v2 全键 + signals 块（argv 增 `--sentinel-family`/`--sentinel-grace-min`）；`board(list)` 顶层 `sentinel_health`（instances/shots_24h/abandoned/echo_tail，纯只读）；resume 增补员/接手建议并刷新 `sentinel/coord-session.txt`；/orch 与 /orch-resume 各补一行；hooks.json 零变更。
- **agent_harvest（工具 9→10）**：只读收割子代理 rollout 转录尾部（末条 model-io 记录内嵌全量对话），按 mission/agent/session 定位，tail/max_chars 截断；跨会话可用（TaskOutput 失效兜底）；子代理 MCP_DISALLOWED 增补。
- **健壮性**：mergeMission schema 白名单（未知顶层键丢弃并在 upsert 响应 `ignored_keys` 列出）；root.txt 重设计（tmp 目录测试根不写全局指针、悬空指针自愈删除、全部读者悬空回退默认根）；v0.4.0 QA 三小修（sandbox_apply applied_at 幂等分支前置至门禁之前、report warn 键名区分（warn_drafted/warn_claim/warn_token + 兼容合并 warn）、悬挂依赖清理 timeline 措辞点名被删 id）。plugin.json 版本 0.4.1。

---

## 20. v0.4.2 增量：成本纪律 doctrine（纯文案零代码）

v0.4.2 的增量设计权威是 `designs/agent-orchestrator-cost-rules-DESIGN.md` §7.1（工作区 designs/ 目录；逐字总装汇于 `designs/agent-orchestrator-v0.5-DESIGN.md` §7.1），本文其余章节描述基线与 v0.2–v0.4.1 增量（见 §15–§19）。纯文案发布：零代码、零 schema、零 board 格式变更（机制化登记 scope_paths/files_touched 与越界审计随 v0.5 落地，本版先发纪律）。增量要点：

- **SKILL 第 20 章「成本纪律（cost-rules）」整章新增**：20.1 文件所有权分区（派发前盘点写集，≥3 文件拆分、≥8 必拆，枢纽文件归单一 mission 独占，在飞写集相交三选一处置）；20.2 分叉与缓存经济（血缘优先选型表：续聊 > workflow 重放 > 重新派发，变体分叉为对比不为省钱）；20.3 上下文预算（S≤20/M≤60/L≤120 步档位写进任务包，硬阈值约 120 步或上下文逼近 230K 强制收尾，对账点=每次 milestone report）；20.4 探针与读回纪律（DB 探针禁 `SELECT *`、单次输出 ≤50 行/≤10KB、≥1000 行文件禁一次全文读入、已读文件不重读）；20.5 验收断言链与回归分层（断言沉淀 `tests/assertions/` 带 ID 文件、harness 沉淀 `tests/harness/`、全量回归仅限发版前/骨架变更/信号链变更）。
- **四处追加**：第 4 章决策表追加「done 且任务登记过写集（RULES 清单或 scope_paths）」审计行（置于沙箱派发行之后）；第 8 章末尾追加「缓存语义选型（先血缘后冷启）」段；第 12 章坑位清单追加「探针原文回显是隐形大头」「已读的文件别重读」两条；第 16 章快速参考追加「成本速查」行。
- **frontmatter**：description 触发词列表末尾追加（m）成本纪律触发句。
- **配套**：plugin.json 版本 0.4.2、workspace 的 plugins/marketplace.json 同步 0.4.2。

---

## 21. v0.5 增量：context manifest / inputs 牵引 / 一次性浓缩 / 守闸门呈现 / cost-rules 机制化

v0.5.0 的增量设计权威是 `designs/agent-orchestrator-v0.5-DESIGN.md`（总装单一事实源，含 D1 清单数据面/D2 浓缩预算/D3 机制化三份分块与 DA4 裁决清单 §13.1；工作区 designs/ 目录），本文其余章节描述基线与 v0.2–v0.4.2 增量（见 §15–§20）。增量要点：

- **S1 context manifest 协议**：report 新增可选 `manifest_entries`（≤12 条；条目七字段 id/layer/type/title/text/ref/source，type 封闭五值 assertion｜env_fact｜anchor｜conclusion｜directive）；done 收口七步管线（形状校验→帽执行→T2 自动补桩→sidecar 原子写 `<存储根>/packs/<mission_id>/manifest.json`→mission.manifest 指针整体替换→assertion 条目机械比对出 `manifest_note`/`manifest_warnings`）；软处置不 isError；截断标记 T0 `…[截断于N字节]`、T1 `…[截断于N字]`。
- **S2 inputs 机械牵引**：context_pack 新增 `inputs`（≤4 个 mission id，层→节确定性路由：T0 逐字块→CONTEXT ≤24KB、T1 一行→SUMMARY ≤4KB、T2 指针→READ FIRST ≤20 条；保序降级永不静默丢；L1/L2/L3 回退链；组包瞬间快照不回灌；牵引文本过沙箱路径改写）、`scope_paths`（≤32 项超限报错；物化 OWNERSHIP 节，沙箱派发时整体取代 oob_allowlist）、`budget`（enum S/M/L，物化 BUDGET 节含 token 档静态预告行）；缺省与旧版同参包逐字节一致。
- **S3 一次性浓缩**：agent_harvest 成功响应追加 `usage`/`file_bytes`/`messages_kind` 元数据（tail=0 即零回显纯探测）；token 档 WARN ≥120K / ACT ≥150K / HARD ≥180K / ABS 230K（主控对账采样、哨兵零参与）；浓缩=受控例外（每 mission ≤1 次、再达 ACT 禁二次浓缩、死亡仍归 agent_harvest），CR-09 v0.5 修订版落 SKILL 20.3；第 4 章决策表增 ACT 行（已有浓缩事件→只剩拆分/放弃）。
- **S4 守闸门呈现**：withComputed 附 `t1_head`/`artifacts_n`/`output_files_n`/`has_question`；resume 对 done/failed 未签收行附 t1_head、blocked/question 行 `question_head` ≤160；mailbox read details 帽 2000 字（标记+提示句，spool 存证不动，peek 不变）；SKILL 新增 20.6 守闸门纪律矩阵小节（单一事实源，第 4/6 章只引用）。
- **S5 cost-rules 机制化**：board upsert 白名单增 `scope_paths`/`strict_scope`/`scope_violations`/`manifest`（均整体替换、不入 ONE_LEVEL；manifest 只读剥离）；F3 冲突预检（默认档 `scope_warnings` 带"三选一"hint、strict 档拒绝登记）、board list 顶层 `scope_conflicts`（≤10 条）；report 可选 `files_touched`（≤50）越界审计（timeline `scope_violation` 事件 + mission.scope_violations 全量重算 + 响应 `warn_scope` 分键）；normalizePathList 提取统一三调用点（trim+`\`→`/`+空串过滤）。
- **bg-gate 收尾（本版唯一 hooks/userConfig 改动）**：C4 提醒句（token 在册但 prompt 无 [channel] 行）；C7 解耦——独立 userConfig `dispatch_contract: remind|ask|off`（默认 remind），background_gate=off 不再连坐契约检查；strict=ask 仅高置信形状升级（deny 永不采用，fail-open 宪法不破）。
- **tests/ 沉淀（CR-13/14 首次执行）**：`tests/assertions/v0.4.x.md`（84 条 bootstrap + A-v050 组）与 `tests/harness/` 八件（jsonrpc-client/temp-root/fixture-board/git-fixture/capture/accelerate/run-all 等）随本版落盘；回归入口 `node tests/run-all.mjs --layer all`。
- **配套**：plugin.json 版本 0.5.0、workspace 的 plugins/marketplace.json 同步 0.5.0；BOARD_VERSION 保持 2、tools/list 恒 10、hooks.json 事件集不变。

---

## 22. v0.5.1 增量指针：哨兵全清零唤醒 / GP+persona 主派发形态 / 对抗性审查入库

v0.5.1 为实战修订版（配套：plugin.json 0.5.1、workspace 的 plugins/marketplace.json 同步 0.5.1、server SERVER_VERSION 对齐 0.5.1），增量要点：

- **哨兵全清零唤醒改造**：全清转 standby 待命零通知、新在飞自动复活、cap 单赢家轮换选举（每周期 ≤1 条）、告警路径零改动——细则权威 SKILL §14 与 tests/suites/sentinel-teardown.mjs。
- **typed 派发快照缺陷应对**：宿主校验读冻结 MCP 快照，含 mcp 工具名的角色派发恒拒；插件侧正式化 GP+persona 主派发形态（SKILL §10）与角色正文双通道上报（report 主 / KIND=xxx 次），根因与评估权威 designs/dispatch-probe-20261014/{DESIGN.md,eval-role-tools.md,findings-S1..S3.md}。
- **对抗性审查全链文档入库** designs/adv-review-20261014/（实锤 47/P0×5——修复工程未启动，非本版内容；QQagent 卡死调查 designs/qqagent-hang-20261014/ 亦未结）。

---

## 23. v0.6 增量指针：probe 第 11 工具 / 鉴权·状态机·apply 包络修复 / root-id 契约 / 文档勘误与断言扩容

v0.6.0 的增量设计权威是 `designs/agent-orchestrator-v0.6-DESIGN.md`（rev.a 总装单一事实源；施工卡片集 `designs/agent-orchestrator-v0.6-impl-plan.md` 13 卡，W-A1/A2/B/C/D/E/F/F2 findings 收编其内；工作区 designs/ 目录），本文其余章节描述基线与 v0.2–v0.5.1 增量（见 §15–§22）。配套：plugin.json 0.6.0、workspace 的 plugins/marketplace.json 同步 0.6.0、server SERVER_VERSION 对齐 0.6.0；tests/ 扩至 16 套（run-all REGISTRY 全入册，A-v060 代码断言族 65 条主句权威 tests/assertions/v0.6.x.md）。增量要点：

- **第 11 号工具 probe（上下文经济第二支柱）**：db.query（拒裸 SELECT *、强制 LIMIT ≤100）/ file.head / file.grep（服务端 -m 语义）/ bin.inspect 四 action；单响应帽 ≤50 行或 ≤10KB、page_token 分页、统一摘要 envelope（rows_truncated/bytes/hash）——帽语义权威 SKILL §20.4，断言 tests/suites/probe-caps.mjs PROBE-01..10（42 检查点）。
- **簇 A server 修复**：report 门 fail-closed+token 熵 hex(16) 双铸点+成对鉴权+claim 必换发+qa 四查+`--strict-tokens` 窄口径开关默认 off（V6-09/14/17/42/19A）；ALLOWED_TRANSITIONS 白名单+closed 双门+sweep 回收扩容（V6-20/11/21）；apply/discard 两阶段 intent+git 管线出锁+幂等三态（V6-08/13/35）；快赢九件+韧性六件+注入三层+V6-12 发布侧 root-id（V6-29/27/36/49/15/33/10/16/22/26/28/48/50/51/18/12）。
- **簇 B hooks/哨兵修复**：locateRoot 契约化六处+root-id 分代门（契约八条权威 v0.6-DESIGN §3.1；矩阵 tests/suites/root-contract.mjs 35 例，含 V6-12 server 行回扫）；哨兵 C3 板面龄期反证（V6-32）；契约头正则统一+代理对回退（V6-53/57）；明示放行半项+claimShots 去 pid+touchSlot 归属校验（V6-52/54/55）。
- **簇 C 文档·角色·断言**：W-C 编辑单 E-01..E-18 落 SKILL/AGENTS/agents/plugin.json（勘误补课、dispatch-probe 补课、文档漂移批量、角色对齐、C-ADD 四项）；typed-dispatch-docs.mjs 18 断言+RECYCLE_LIST 宿主修复事件回收机制（断言双模，ORCH_HOST_FIXED=1 反向）；E-19/E-20 CONFLICT-1 裁决回写 designs/adv-review-20261014/SUMMARY.md（采信 V4-P1-2）。
- **非代码随行**：W-F/W-F2 唤醒通道调研入库（remote v4 通道协议逆向，V1 改判「可行-约束型」；watcher 0.7 立项建议）——调研产物，非本版代码内容。
