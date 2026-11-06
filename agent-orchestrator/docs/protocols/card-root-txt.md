# Contract card 3: root.txt + root-id (the storage-root pointer and identity)

> **Line-number declaration (card head)**: all line numbers in this document were measured at assembly time (grep + line-by-line source verification). Line numbers are **not referenced across versions**; cross-version locating relies on function/file-name anchors (l-20261022-6a14d6).
>
> - Home modules: mcp/server-core.mjs (publish + self-heal, the root.txt bridge section; the four anchors `ensureRootId`/`rootIdOf`/`isTempDirPath`/`isTempRoot`) + the five verbatim locateRoot twins (hooks/{bg-gate,journal,session-start,stop-check}.mjs + hooks/bg-sentinel/core.mjs - locateRoot resides in the bg-sentinel module after the family split; behavior is matrix-locked by tests/suites/root-contract.mjs, zero code sharing)
> - Brittleness dual-axis rating: **consequence severity = top tier (the heaviest of the five protocols, tied with sentinel/)** - the only protocol whose failure consequences are **global**: residual distortion = all hooks go blind / bg-gate false alarms / sentinel self-destruction (legacy list item 7; all other protocols' failure consequences stay within a single mission/subagent); **surface breadth = medium** (readers fixed at 5 hook scripts + six root-id validation points, no evolution face)

**Invalidity semantics, three classes of notation**: `fail-loud` (one stderr warning line, behavior visible) / `self-healing` (recovers automatically to the correct state) / `silent degradation` (continues on the safe default).

---

## 0. Two files, one contract

| 文件 | 位置 | 格式 |
|---|---|---|
| `root-id` | 每个存储根内（含自定义根与默认根） | 单行 16 hex＋`\n`；server `ensureRootId` 生成（mcp/server-core.mjs，`hex(8)`）；**写一次永不轮换**（persistent and stable，契约注释） |
| `root.txt` | **默认根** `<project>/.zcode/orchestrator/root.txt`（指针永落默认根，不随自定义根走） | **v2 双行**：L1=目标存储根路径，L2=目标 root-id（16 hex）；**v1 单行**（v0.4.1-v0.5.1 旧格式，兼容读） |

The contract-authority comment block: the mcp/server-core.mjs root.txt bridge section (three sections: publish side / self-heal / hooks sharing the same contract). The server itself **never reads the pointer to locate itself** - it already knows its root via --root/the default rule.

---

## The four columns

### Writers

| 写点 | 语义（实测锚） |
|---|---|
| **server 启动·发布**（唯一常规写方） | 运行根=非默认且非 temp → 对默认根 `root.txt` **无条件重写 v2 双行**（mcp/server-core.mjs 发布段，atomicWriteFileSync；注释：id 恒与「最近在此运行的根」一致——多项目共用默认根时指针天然指向最后运行者，消费端按读时校验兜底） |
| **server 启动·自愈**（唯一删除方） | 运行根=默认根 → 读存量指针六分支判定（mcp/server-core.mjs 自愈段）：①dangling（目标不存在）→ unlink；②目标在 temp 目录（isTempDirPath，mcp/server-core.mjs，os.tmpdir() relative 判定）→ unlink（测试根不粘滞 "test root must not stick"）；③v1 单行格式 → 目标**已升级**（有 root-id）才保留，否则 unlink（旧 server 下次启动自行升级）；④v2 双行 id 失配（或目标 root-id 不可读）→ unlink（stale）；⑤其余保留；⑥**本根优先例外**（F1-01，v1.4 W3 行为腿 root-contract S6 锁；判定序先于⑤）——混配场景：运行根=默认根 ∧ 存量指针 v2 自洽（双行 id 与目标根 root-id 对得上）∧ 本根有 board.json → **unlink**（「混配=误配置」非支持面，G1-4；删除=本根优先，是⑤「其余保留」的例外腿）。全 best-effort（catch 兜底） |
| **server 启动·root-id 落根** | ensureRootId（mcp/server-core.mjs）：根内无合法 root-id（`^[0-9a-f]{16}$` 校验，rootIdOf 强校验）→ 生成写入；已有 → 原样沿用 |
| **temp 测试根豁免** | isTempRoot（mcp/server-core.mjs）→ 既不发布指针也不进入自愈分支——套件/探针零真实根污染 |
| **hooks** | **零写方**——hooks 不删指针（session-start.mjs 契约头注释现址 :186「删除职责全归 server 自愈」，2026-11-02 实测；bg-gate :75／journal :33／stop-check :708 同文在册）、不改写指针；watcher 也从不触碰（watcher/watcher.mjs :12 明示从不读） |

### Readers

| 读方 | 语义（实测锚） |
|---|---|
| **5 个 hook 脚本 locateRoot**（verbatim twin 五处同文） | bg-gate.mjs／hooks/bg-sentinel/core.mjs（族拆分后驻留模块）／journal.mjs／session-start.mjs／stop-check.mjs（主清点与镜像记录两路径共用）——现址时点=2026-11-02 W4 实测。读序：指针优先 → 无指针/空指针 → 默认根（先做祖先回退判定）；采信前过分代门（见失效语义） |
| **root-id 的读方**（六处） | server rootIdOf（mcp/server-core.mjs，**强校验**：`^[0-9a-f]{16}$` 不合→null）＋5 hooks rootIdOf（各脚本同文；**弱读**：read+trim，无格式校验，空=“” 视为无）＋祖先回退存在性检查（board.json ∧ root-id 双件套） |
| **watcher 不读**（DP2a 勘误注记） | watcher/watcher.mjs :12 注释明示「**从不读 root.txt 指针**」——定根走 --root 优先/默认 `<cwd>/.zcode/orchestrator`。DP2a 卡③「7 消费方」的 grep 命中实为该否定注释；本卡以实测 **5 读方** 为准 |
| **server 不读指针自定位** | 契约注释明示（mcp/server-core.mjs root.txt bridge 区）；server 的 root 来自 --root 参数或默认规则，指针只服务 hook 脚本面契约 |

### Fields

| 字段 | 类型/值域 | 语义 |
|---|---|---|
| root.txt L1（v2/v1 共用） | string：目标存储根绝对路径 | 唯一路径字段；读取侧按行 trim＋滤空（server-core 指针解析段） |
| root.txt L2（仅 v2） | string：16 hex，须 === 目标根 `root-id` 文件内容（trim 后） | 绑定指针与根身份；防「路径复用/旧根复活」型残留失真 |
| root-id | string：16 hex＋`\n`（server 侧强校验 `^[0-9a-f]{16}$`） | 根的持久身份；写一次不轮换 |
| 行数语义 | 1 行=v1 旧格式；≥2 行=v2（取 L2 为 id；多余行忽略） | 分代门判据（hooks 采信侧分代门＋server 自愈侧 v1 分支） |

无 schema 校验=裸 txt；hooks 侧对 L1/L2 的唯一结构假设=按 `\r?\n` split＋trim＋滤空。

### Failure semantics (hooks consumer-side six branches + server self-heal-side six branches)

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

## Assertion anchors

- **root-contract.mjs** (tests/suites/root-contract.mjs, the behavioral matrix) - the thickest assertion face of the five protocols: six implementations (five verbatim twin scripts + the two stop-check paths) x generation gates (temp rejection / strong validation / weak validation / dangling / empty pointer) x the ancestor-fallback matrix x the five-twin consistency lock; the server publish/self-heal side activates after behavioral probing. **This document card needs comparison only, no added assertions (not a bare zone)**.
- root-id generation/validation: covered by the root-contract fixture face (the V6-56 slot root field linkage assertion).
- Bare-zone note: **none** (this card is the most completely assertion-covered protocol face of the five; the residue = the v1->v2 automatic upgrade path "the old server upgrades on its next start" depends on mixed running and has no standalone assertion - noted and accepted).
