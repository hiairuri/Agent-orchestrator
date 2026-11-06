# 契约卡③ root.txt + root-id（存储根指针与身份）

> **行号声明（卡头）**：本文全部行号系 **2026-10-28 总装时点实测**（grep + 实码逐行核对，worker v12-m11，plugin v1.1.2：mcp/server.mjs 10657 行 / hooks 五脚本合计 ~3748 行）。行号**不作跨版引用**；跨版定位以函数名/文件名锚为准（l-20261022-6a14d6）。
>
> - 归属模块：mcp/server-core.mjs（发布+自愈，root.txt bridge 区；`ensureRootId`/`rootIdOf`/`isTempDirPath`/`isTempRoot` 四锚）＋ locateRoot 五处 verbatim twin（hooks/{bg-gate,journal,session-start,stop-check}.mjs ＋ hooks/bg-sentinel/core.mjs——bg-sentinel 系 v1.3 族拆分后 locateRoot 驻留模块；行为由 tests/suites/root-contract.mjs 矩阵锁定，零代码共享）
> - 脆度双轴评级：**后果重度=第一梯队（五协议中最重，与 sentinel/ 并列）**——唯一失效后果**全局性**的协议：残留失真=hooks 全体失明／bg-gate 误报／哨兵自毁（遗留清单第 7 条在案；他协议失效后果均限单 mission/单子代理）；**面广度=中**（读方固定为 5 个 hook 脚本＋root-id 六处校验点，无演进面）
> - 历史事故回链：AGENTS.md 遗留清单第 7 条（存储根迁移后 root.txt 指向失效旧根=hooks 全体失明/bg-gate 误报/哨兵自毁，本卡失效语义节的直接标的）；V6-30（≤v0.4.0 旧版无 root-id 劫持，v1 弱校验天然中和）；V6-12（v0.6 发布侧 v2 指针）；W20/W22（祖先回退）；W24（五处 twin 一致性锁）
> - 2026-11-02 W4 E1 勘误：v1.1.2 时点旧单体行号死锚已按 split-anchor-map §3 终态映射改模块级锚（server 侧=mcp/server-core.mjs 四锚；bg 域 locateRoot/rootIdOf=hooks/bg-sentinel/core.mjs）；未拆分单文件行引用逐条核现址更新。本勘误只涉锚面与表述面；W3 行为腿的卡面语义同步未在 E1 域内——遗留观察见 tests/assertions/v1.4.0.md W4 节。

**失效语义三分类记法**：`fail-loud`（stderr 告警一行，行为可见）／`自愈`（自动恢复到正确态）／`静默降级`（按安全缺省继续）。

---

## 0. 两个文件、一个契约

| 文件 | 位置 | 格式 |
|---|---|---|
| `root-id` | 每个存储根内（含自定义根与默认根） | 单行 16 hex＋`\n`；server `ensureRootId` 生成（mcp/server-core.mjs，`hex(8)`）；**写一次永不轮换**（persistent and stable，契约注释） |
| `root.txt` | **默认根** `<project>/.zcode/orchestrator/root.txt`（指针永落默认根，不随自定义根走） | **v2 双行**：L1=目标存储根路径，L2=目标 root-id（16 hex）；**v1 单行**（v0.4.1-v0.5.1 旧格式，兼容读） |

契约权威注释块：mcp/server-core.mjs root.txt bridge 区（publish side / self-heal / hooks 同契约三段）。server 自身**从不读指针定位自己**——它经 --root/默认规则已知自己的根。

---

## 四栏

### 写方

| 写点 | 语义（实测锚） |
|---|---|
| **server 启动·发布**（唯一常规写方） | 运行根=非默认且非 temp → 对默认根 `root.txt` **无条件重写 v2 双行**（mcp/server-core.mjs 发布段，atomicWriteFileSync；注释：id 恒与「最近在此运行的根」一致——多项目共用默认根时指针天然指向最后运行者，消费端按读时校验兜底） |
| **server 启动·自愈**（唯一删除方） | 运行根=默认根 → 读存量指针六分支判定（mcp/server-core.mjs 自愈段）：①dangling（目标不存在）→ unlink；②目标在 temp 目录（isTempDirPath，mcp/server-core.mjs，os.tmpdir() relative 判定）→ unlink（测试根不粘滞 "test root must not stick"）；③v1 单行格式 → 目标**已升级**（有 root-id）才保留，否则 unlink（旧 server 下次启动自行升级）；④v2 双行 id 失配（或目标 root-id 不可读）→ unlink（stale）；⑤其余保留；⑥**本根优先例外**（F1-01，v1.4 W3 行为腿 root-contract S6 锁；判定序先于⑤）——混配场景：运行根=默认根 ∧ 存量指针 v2 自洽（双行 id 与目标根 root-id 对得上）∧ 本根有 board.json → **unlink**（「混配=误配置」非支持面，G1-4；删除=本根优先，是⑤「其余保留」的例外腿）。全 best-effort（catch 兜底） |
| **server 启动·root-id 落根** | ensureRootId（mcp/server-core.mjs）：根内无合法 root-id（`^[0-9a-f]{16}$` 校验，rootIdOf 强校验）→ 生成写入；已有 → 原样沿用 |
| **temp 测试根豁免** | isTempRoot（mcp/server-core.mjs）→ 既不发布指针也不进入自愈分支——套件/探针零真实根污染 |
| **hooks** | **零写方**——hooks 不删指针（session-start.mjs 契约头注释现址 :186「删除职责全归 server 自愈」，2026-11-02 实测；bg-gate :75／journal :33／stop-check :708 同文在册）、不改写指针；watcher 也从不触碰（watcher/watcher.mjs :12 明示从不读） |

### 读方

| 读方 | 语义（实测锚） |
|---|---|
| **5 个 hook 脚本 locateRoot**（verbatim twin 五处同文） | bg-gate.mjs／hooks/bg-sentinel/core.mjs（族拆分后驻留模块）／journal.mjs／session-start.mjs／stop-check.mjs（主清点与镜像记录两路径共用）——现址时点=2026-11-02 W4 实测。读序：指针优先 → 无指针/空指针 → 默认根（先做祖先回退判定）；采信前过分代门（见失效语义） |
| **root-id 的读方**（六处） | server rootIdOf（mcp/server-core.mjs，**强校验**：`^[0-9a-f]{16}$` 不合→null）＋5 hooks rootIdOf（各脚本同文；**弱读**：read+trim，无格式校验，空=“” 视为无）＋祖先回退存在性检查（board.json ∧ root-id 双件套） |
| **watcher 不读**（DP2a 勘误注记） | watcher/watcher.mjs :12 注释明示「**从不读 root.txt 指针**」——定根走 --root 优先/默认 `<cwd>/.zcode/orchestrator`。DP2a 卡③「7 消费方」的 grep 命中实为该否定注释；本卡以实测 **5 读方** 为准 |
| **server 不读指针自定位** | 契约注释明示（mcp/server-core.mjs root.txt bridge 区）；server 的 root 来自 --root 参数或默认规则，指针只服务 hook 脚本面契约 |

### 字段

| 字段 | 类型/值域 | 语义 |
|---|---|---|
| root.txt L1（v2/v1 共用） | string：目标存储根绝对路径 | 唯一路径字段；读取侧按行 trim＋滤空（server-core 指针解析段） |
| root.txt L2（仅 v2） | string：16 hex，须 === 目标根 `root-id` 文件内容（trim 后） | 绑定指针与根身份；防「路径复用/旧根复活」型残留失真 |
| root-id | string：16 hex＋`\n`（server 侧强校验 `^[0-9a-f]{16}$`） | 根的持久身份；写一次不轮换 |
| 行数语义 | 1 行=v1 旧格式；≥2 行=v2（取 L2 为 id；多余行忽略） | 分代门判据（hooks 采信侧分代门＋server 自愈侧 v1 分支） |

无 schema 校验=裸 txt；hooks 侧对 L1/L2 的唯一结构假设=按 `\r?\n` split＋trim＋滤空。

### 失效语义（hooks 消费侧六分支 + server 自愈侧六分支）

**hooks 侧（locateRoot，任一失败 → 回退默认根＋stderr 告警一行 `fail-loud`，hooks 永不删指针）**：

1. 无指针/空指针 → 默认根，先做**祖先回退判定**（W20/W22：默认根既无 board.json 也无 root-id 时，自 projectDir 向上找最近祖先的 .zcode/orchestrator 双件套；命中 stderr 一行 `fail-loud`，未命中静默默认根）——`静默降级`。
2. **temp 拒绝**（两代通用）：目标位于 os.tmpdir() 内 → 拒采信回退（`fail-loud`，stderr"目标位于临时目录"）。
3. **悬空指针**（目标不存在/非目录）→ 拒采信回退（`fail-loud`，stderr"目标不存在或不是目录"）。
4. **v2 强校验失败**：目标缺 root-id → 拒（`fail-loud`）；root-id 与指针内嵌 id 失配 → 拒（`fail-loud`）——AGENTS.md 遗留清单第 7 条的残留失真由此被读端拦截为"回退默认根"而非"全体失明"。
5. **v1 弱校验**（v0.4.1-v0.5.1 兼容）：目标存活 ∧ 目标有 root-id 即采信（值不比对）＋stderr 旧格式提示"重启 server 后自动升级"（`静默降级`＋`fail-loud` 提示）；目标无 root-id → 拒（V6-30 ≤v0.4.0 劫持形态天然中和）。
6. **board.json 存在性校验**（v1.4 W3 F1-02，root-contract P11 腿 B 锁）：指针目标缺 board.json ∧ 默认根有 board.json → 拒采信回退默认根＋stderr 告警一行 `[orch-root-contract] root.txt target lacks board.json; falling back to default root`（rootContractStderr 五处 twin 同款）——NOBOARD（有 root-id 无板）=本链唯一因板缺席否决点，五实现矩阵同形（journal/bg-gate/session-start/stop-check 镜像/bg-sentinel）。

**server 侧自愈（唯一删除方，`自愈`）**：写方表自愈行①-⑥判定的五类 stale 指针（dangling/temp/v1-目标未升级/v2-id 失配/混配自洽〔F1-01 本根优先例外，v1.4 W3 S6 锁〕）在下次默认根 server 启动时 unlink（mcp/server-core.mjs 自愈段）；删除后 hooks 下次定根自然回落默认根或祖先根。

**全局后果链（本卡评级依据）**：指针失真未被自愈清除时（如用户手工改路径、存储根迁移后旧根复活），五 hooks 一致解析到失效根 → board/spool/memory 全部读空（"hooks 全体失明"）→ bg-gate 无板可判（误报面）→ bg-sentinel 在错误根盯守（"哨兵自毁"）。防线=读端六分支拦截（fail-loud 留痕）＋server 自愈（唯一删方）＋root-id 绑定（路径复用失效）。

**竞态面**：指针发布（server 启动）与 hooks 读取无锁——atomicWriteFileSync tmp+rename 保证读侧只见完整旧/新文件；id 失配窗口由「发布无条件重写＋hooks 采信前比对」收敛。

---

## 断言锚

- **root-contract.mjs**（tests/suites/root-contract.mjs，v0.6 B1 行为矩阵）——五协议中断言最厚的一张：六处实现（五脚本 verbatim twin＋stop-check 两路径）× 分代门（temp 拒绝/强校验/弱校验/悬空/空指针）× W22 祖先回退矩阵 × W24 五处 twin 一致性锁；server 发布/自愈侧（V6-12 归簇 A）行为探测后启用。**文档卡只需对拍不需补断言（非裸区）**。
- root-id 生成/校验：root-contract fixture 面覆盖（V6-56 槽位 root 字段联动断言）。
- 裸区注记：**无**（本卡为五协议中断言覆盖最完整的协议面；残余=v1→v2 自动升级「旧 server 下次启动升级」路径依赖混跑，无独立断言，注记接受）。
