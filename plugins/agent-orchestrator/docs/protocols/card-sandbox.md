# 契约卡：sandbox 沙箱生命周期（M4）

> **行号声明（卡头）**：本文行号系 **2026-10-28 总装时点实测**（grep+实码逐行核对，worker v12-m71；server.mjs 约 10657 行量级）。行号**不作跨版引用**；跨版定位以函数名锚为准（l-20261022-6a14d6）。
>
> - **归属模块**：M4 sandbox（mcp/server.mjs 沙箱写面：`materializeSandbox` ~L1575、`toolSandboxApply` ~L7355、`toolSandboxDiscard` ~L7744）＋ M3 dispatch（context_pack 的 isolation/oob_allowlist/scope_paths/share_node_modules 参，~L6184-6250）
> - **脆度双轴评级**：面广度=中（两收口工具+组包三参）；**后果重度=第一梯队**（apply 的 merge 直接动主仓主线，git 历史不可逆——门禁链是唯一防线，故 apply 侧门禁最厚）
> - **历史事故回链**：V6-08（两阶段 intent+幂等三态，治锁内长 git 崩窗）/V6-13（git 管线出锁，治锁占用风暴）/V6-35（teardown 后置降级，治 merge 已落仍抛）/V6-42 AUTH-08（qa 裸 verdict 纸门→四查链）/V6-10（coversPath 单一来源）/ENV-01（两慢 merge 场景套内重试稳定化，crv5-apply-envelope）
> - **scope 注记**：本卡属 M4「不立项增强」（G1 同构裁定 K-6）；本卡只记现状契约。scope_paths 面写 allowlist 演进（v1.0 manifest 起取代 oob_allowlist 主口径）由 M2/M3 卡族承载，本卡按现状并记两参。

**失效语义三分类记法**：`fail-loud`（显式报错，行为可见）／`自愈`（自动收敛到正确态）／`静默降级`（按安全缺省继续，留痕有限）。

---

## 0. 生命周期总览（create → 施工 → apply / discard）

| 阶段 | 执行者 | 关键函数锚 | 产物 |
|---|---|---|---|
| create | context_pack（isolation=worktree 时） | `materializeSandbox`（server ~L1575，调用点 ~L6220，根锁内） | worktree＋分支＋`pack.sandbox` 记录＋SANDBOX 节 |
| 施工 | worker（沙箱内） | —（SANDBOX 节红线约束） | 分支上提交＋diff 存证 artifacts |
| 收口 A | 主控 | `toolSandboxApply`（~L7355，三阶段） | merge 落主线＋board closed 自动签收 |
| 收口 B | 主控 | `toolSandboxDiscard`（~L7744，三阶段） | 分支/worktree 弃置，board 状态不动 |

## 1. create：materializeSandbox

| 栏 | 内容 |
|---|---|
| **写方** | server 独占（context_pack isolation=worktree 分支；根锁内执行） |
| **读方** | worker（worktree 内施工）；server（apply/discard 按 pack.sandbox 记录定位） |
| **门（fail-loud）** | 非 git 项目（rev-parse 失败/不在工作树）→ `ToolError('非 git 项目…')`；空仓（无 HEAD）→ 拒；git 缺失（ENOENT）→ 拒；merge-tree 预检不支持（旧版 git，`assertMergeTreeSupport` ~L1161 探测+进程内缓存）→ 拒——沙箱写面在这四种环境下一律降级 isolation="none" 由主控显式选择，server 不静默降级 |
| **自愈** | `worktree prune` 先行清 stale 元数据；worktree 三态复用：分支存在且已注册→幂等复用（重打包安全）；分支存在未注册→attach；否则 `worktree add -b orch/<mission_id>` 新建于 `<root>/sandboxes/<mission_id>` |
| **字段** | `pack.sandbox` 全字段（~L1630）：`isolation:"worktree"`／`root`（worktree 绝对路径）／`branch`（`orch/<完整 mission_id>`）／`base_commit`／`junction_shared:boolean`／`oob_allowlist`（normalize 后清单）／`created_at`／`apply_intent_at:null`（V6-08 两阶段 intent 位）／`applied_at:null`／`applied_commit:null`／`discarded_at:null`。timeline 追加 `sandbox:create` 事件 |
| **失效语义** | node_modules junction：主仓 node_modules 存在且参=share 时 symlink（junction）创建；已链接=复用；创建失败（跨卷等）=**`junction_shared:false` 静默降级**（永不 fail 派发）；沙箱记录经 `assertInside(root, wtDir)` 路径包含校验（逃逸=拒） |

**SANDBOX 节物化**（`buildSandboxLines` ~L1656，逐行）：工作区路径+分支+基点；包内项目路径已改写声明（未改写残留按同相对路径到工作区读）；红线行「绝不写原项目路径——写穿主仓会被主仓 status 巡检与 reviewer 越界审查检出，整单丢弃（sandbox_discard）」；node_modules 行（junction 共享=只读使用、禁 install/upgrade/delete、需装依赖先删链接独立安装并报告注明）；done 上报必附 `git diff --stat <base>` 与 `git diff --name-only <base>` 输出各存文件进 artifacts（**diff 存证要求**，reviewer 审查输入）。

## 2. apply：toolSandboxApply 三阶段（V6-08/13/35）

| 阶段 | 锁 | 内容 |
|---|---|---|
| phase-1 | 根锁内 | **幂等三态先行**＋门禁链＋intent 写入（commit point） |
| phase-2 | 无锁 | porcelain 巡检→越界 diff 检出→`merge --no-ff`→rev-parse 取 applied_commit；任一步抛错=清 intent 后重抛（不占 10min busy 窗） |
| phase-3 | 根锁内 | FRESH loadBoard 重定位＋硬身份校验＋applied-wins 结算 |
| teardown | 无锁（phase-3 后，V6-35） | worktree 移除失败降级 `worktree_removed:false`+warning，不越过已落 merge |

### 2.1 幂等三态（phase-1 先于一切门禁执行）

| 前置态 | 判定 | 收敛 |
|---|---|---|
| 已应用 | `applied_at` 在 | 补偿关闭：status≠closed 则置 closed+auto-ack（by=sandbox_apply），返回 `already_applied:true`（v0.4.1 fix 保留：幂等分支先于 done/qa 门——merge 既落，结账恒正确） |
| intent+已合入 | `apply_intent_at` 在 ∧ `merge-base --is-ancestor` 判分支已在主线 | crash-after-merge 自愈（`自愈`）：直达 phase-3，applied_commit 取收口时 HEAD，响应 `recovered:true` |
| intent 新鲜未合入 | `apply_intent_at` 在 10min 新鲜窗（`applyIntentFresh`）内 | 结构化 busy：`{ok:true, apply_in_progress:true, note}`（跨进程在飞保护+apply↔discard 互斥同窗） |
| intent 过期未合入 | 新鲜窗外 | 删 intent 落回门禁链重走（qa 可能已变，全量重验） |

### 2.2 门禁链（fail-loud，逐条 ToolError）

1. **沙箱记录门**：`pack.sandbox.isolation==="worktree"` 否则「该 mission 非沙箱派发」。
2. **done 门**：status 必须 done。
3. **qa 四查链**（V6-42 AUTH-08，治自审自批）：① `qa.verdict==="pass"`；② `qa.reviewed_by` 指向的 mission 存在且 done/closed；③ 该 mission 的 agent_type 含 `reviewer`；④ 评审与目标互指（评审 mission 的 `qa.mission_id` 或 artifacts 引用本 mission id）。缺任一显式报错指名缺项，**无静默降级**。
4. **merge-tree 预检**（`assertMergeTreeSupport`+`git merge-tree --write-tree HEAD <branch>`，内存合并不触工作树）：status=1 → isError 附 `conflict_files` 清单+**合并代理四件套指引**（merge-base＋主线侧 diff＋分支侧 diff＋冲突文件两侧内容；派独立合并 mission 解决后复审再 apply）。`fail-loud`，主仓零触碰。
5. **intent commit point**：以上全过才写 `apply_intent_at` 并落盘——此后主仓 git 工作不再持根锁（V6-13）。

### 2.3 phase-2 git 管线与门

- **porcelain 巡检**：主仓工作树不干净 → isError 附 porcelain 清单与处置指引；`allow_dirty=true` 为**唯一人工逃生**（确认属己方改动时）；**qa 门无逃生口**。
- **越界机械检出**（V6-10 单一来源 `coversPath` 前缀匹配）：`listDiffNames(base..branch)` 对 allowlist 过滤；非空 allowlist 下越界 → isError 附越界清单+处置（verdict 改 fail 走 discard 整单弃，或修订 allowlist 重审再 apply）；**空 allowlist=全放行**（登记面缺省语义，非豁免背书）。
- **合并**：`merge --no-ff --no-edit -m "orch: apply <mission_id>"`，applied_commit=收口时 HEAD。

### 2.4 phase-3 结算与失效语义

- **硬身份校验**（branch/base_commit 与 intent 时点比对）：漂移 → `applied 胜出，未回滚` warning（git 历史不可逆，R7）；status/qa 在 phase-2 期间漂移 → 同为 applied-wins warning，不回滚；mission 消失但 merge 已落 → isError「以 git log 为准人工核对」（`fail-loud`，不可静默）。
- **结算事务**：status=closed＋auto-ack（by=sandbox_apply）＋`applied_at/applied_commit` 落 sandbox＋timeline `sandbox:apply` 事件（含 crash 恢复收口措辞）。
- **teardown 降级**（V6-35）：junction 链接先摘（rmSync 对 junction 只摘链不摘目标）；worktree 移除失败 → `worktree_removed:false`+warning，残留可被 discard 的 force 路径收尾（`静默降级`，有痕）。

## 3. discard：toolSandboxDiscard 三阶段

| 阶段 | 内容 | 失效语义 |
|---|---|---|
| phase-1（锁内） | `discardGate`：沙箱记录门（非沙箱 mission 永不触碰）＋**新鲜 apply intent 拒绝 discard**（apply↔discard 互斥 V6-08：在飞 merge 下删分支会断 apply 管线）；已 applied 的残留清理（V6-35 `worktree_removed:false` 后续）是合法 discard，放行 | `fail-loud` |
| phase-2（无锁） | `discardGitTriple`：`worktree prune` 自愈→摘 junction 链接→已注册则 `worktree remove --force`（**全插件唯一 --force 点**，仅弃置语义）／未注册残留目录 rmSync 强删→`branch -D`（分支已无=幂等通过） | 缺件即跳过（`自愈`/幂等） |
| phase-3（锁内） | `discardSettleBoard`：FRESH 板上**applied-wins 仲裁**——phase-1 后 phase-3 前被 apply 抢先（applied_at 从无到有）→ discard 中止且大声报错；phase-1 前已 applied → 合法残留清理放行。`discarded_at` 落戳，**status 不动**（done 保持 done，close 与否归主控裁） | 竞态 `fail-loud`，余 `自愈` |

主仓零损伤不变量：discard 全程不触主仓工作树与主线（git 三连只作用沙箱侧）；apply 全程主仓唯一写点=phase-2 末次 merge（其前置门禁全在 phase-1/2）。

## 4. scope 三粒度冲突语义（登记面，与 apply 门禁分立）

| 粒度 | 机制 | 锚 |
|---|---|---|
| 默认档 | scope 与在飞 mission 写集相交 → 登记放行＋`scope_warnings` 附「三选一」hint（不拒绝） | `scopePairConflict`（server ~L1369-1445） |
| strict 档 | `patch.strict_scope === true` → 相交即 `ToolError`「strict_scope 拒绝登记…（board 未改动）」 | ~L1429-1436 |
| 观测面 | board list 顶层 `scope_conflicts`（在飞相交对，帽内条数）供主控巡检 | ~L1445 起 |

与沙箱越界检出的分工：登记冲突管「派发前写集声明」，coversPath 越界 diff 管「施工后实际改动」——两道独立，缺一不可互替。

## 5. 断言锚

- **crv5-apply-envelope**：apply/discard 两阶段包络＋幂等三态＋ENV-01 两慢 merge 场景套内失败重试一次（全新临时根重跑、断言集不变）。
- **crv1-scope**：scope 三粒度冲突语义（scope_warnings/strict 拒绝/scope_conflicts）。
- **crv6-resilience / root-contract / twin-lock**：根锁与路径包含校验为共享基建（跨卡：card-root-txt）。
- **函数名锚（LM-05 候选行素材，供持 lint-manifest 写面的波次注册）**：`materializeSandbox`／`applyGateAndIntent`／`applyGitPipeline`／`applySettleBoard`／`applyTeardown`／`toolSandboxApply`／`toolSandboxDiscard`／`discardGate`／`discardGitTriple`／`discardSettleBoard`／`assertMergeTreeSupport`／`parseMergeTreeConflicts`／`applyIntentFresh`／`buildSandboxLines`／`coversPath`／`scopePairConflict`（均 server.mjs，2026-10-28 grep 实证可见）。

## 6. 维护规则

- apply 门禁链新增查项：本卡 §2.2 补行＋crv5-apply-envelope 补断言同波落；删查项=防御降级，须 DESIGN 治理面留痕。
- 幂等三态窗口/新鲜窗时长调整：属行为契约变更，按 l-20261022-5564ee 先盘点断言面再动（crv5 有字面与行为双面）。
- scope 语义演进（如 scope_paths 取代 oob_allowlist 的过渡收尾）：§4 与 crv1-scope 同波改，过渡期双参并存事实在本卡与 card-result-dir 各自记一面。
- 本卡不立项增强（G1/K-6）：机制改动仅限缺陷修复；物理拆 server.mjs 沙箱段被 G1 虚拟分区裁定禁止，勿将本卡读作拆分 mandate。
