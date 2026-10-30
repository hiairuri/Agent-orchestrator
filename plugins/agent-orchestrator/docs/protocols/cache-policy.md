# 缓存策略：probe 会话读缓存（LRU64 + SQL 门）

- **定位**：observe 侧缓存策略文档（v0.7 V7-01/W-A §2 落地面的契约文档；probe 协议本体归 `card-probe.md`——G1 虚拟分区：probe 不物理拆，本文档与 probe 卡**分立**：卡管四动作协议面，本文管「同参重探怎么省字节」的缓存机制面）
- **设计动机**：重复同参 probe 的完整响应会把已读过的字节再灌一遍上下文。缓存把「不要重复探查」从模型纪律变成机制——同参重探折算成 ~100B 存根（W-A §2：在唯一分发咽喉点 toolProbe 收口）
- **锚点声明**：本卡行号系总装时点（v1.2 源码）实测，**不作跨版引用**（l-20261022-6a14d6）；函数名/常量名双锚为定位权威

---

## 1. 缓存范围（准入门）

| 项 | 内容 | 锚点 |
|---|---|---|
| 可缓存动作 | `file.head` / `file.grep` / `bin.inspect`（PROBE_CACHE_ACTIONS 三件） | :9098 |
| **SQL 门（永不缓存）** | `db.query` 整体出列——SQLite 文件被外部进程可变，mtime 不是可信失效因子，按构造排除 | :9091-9093 |
| **续页门（永不缓存）** | 携 page_token 的调用不读也不写缓存——offset 语义下存根无意义；续页新鲜度由 token 自身 sz 绑定守护（probeDecodeToken） | :9093-9095 |
| **逃逸门（no_cache）** | `no_cache:true`：不读缓存强制全量重读，且**该次结果不写缓存**（首探即 no_cache 则零缓存残留） | :9144；schema :9892-9896 |
| 只入合格响应 | 仅 `ok===true` 且 hash 为字符串的响应入缓存（ToolError/畸形响应不入） | :9162-9163 |

## 2. 键与失效（无通知协议）

| 项 | 内容 | 锚点 |
|---|---|---|
| 键形状 | `JSON([action, flatArgs, mtimeMs, size])`——flatArgs=入参去 page_token/no_cache、键排序、undefined 剔除后的规范形 | probeCacheKey :9105-9112 |
| 失效因子 | **mtimeMs+size 双因子内嵌在键里**——宿主任何写动作都移动键→miss→全量重读。无需任何写通知协议（与 page_token sz 绑定同一哲学：文件事实自证） | :9095-9097；:9101-9104 |
| 双因子理由 | V7-01/CACHE-06 教训：单 mtime 抗不住同毫秒写；bytes+mtimeMs 双读才稳 | :10142-10145 同款论述 |

## 3. 存根与 LRU64

| 项 | 内容 | 锚点 |
|---|---|---|
| 容量 | PROBE_CACHE_MAX_ENTRIES=**64** 条；每条 envelope 本身 ≤10KB（probe 自帽）→整缓存 ≤640KB，无第二字节帽 | :195-198 |
| 淘汰 | Map 插入序即 LRU：命中 delete+set 触摸（touch）；超 64 驱逐最旧（插入序最早） | :9099；:9157-9166 |
| 存根形状 | `{ok, tool, action, path, cached:true, cached_at, prior_hash, prior_bytes, note}`——**机器诚实的指针，永不携 payload**（携 payload 即抵消省字节）；note 声明 no_cache:true 逃逸面 | probeCacheStub :9114-9130 |
| 触达路径 | toolProbe 咽喉：可缓存动作∧无 page_token∧无 no_cache→解析 path+stat→查缓存→命中返存根/未命中执行并入缓存 | toolProbe :9142-9172 |

**残余场景（no_cache 存在的理由）**：首次全量响应已被会话浓缩/裁剪出上下文、只剩 hash 指针在场——此时存根指向的上文已不可见，`no_cache:true` 强制真重读（:9114-9117 注释原文语义）。

## 4. 失效语义

| 情形 | 行为 | 分类 |
|---|---|---|
| 同参重探（文件未变） | 存根（cached:true+prior_hash=上次 hash） | 设计内 |
| 文件被写后重探 | 键移位→miss→全量重读（新 hash 入缓存） | 自愈（无通知） |
| db.query 任意重探 | 恒全量（SQL 门） | 设计内 |
| 续页调用 | 恒绕缓存读写 | 设计内 |
| no_cache 调用 | 恒全量且不污染缓存（后续同参调用仍走原缓存项） | 设计内 |
| 首探即 no_cache | 零缓存残留（后续重探也全量） | 设计内（CACHE-03） |
| stat 失败（path 不可解析） | 保守回落：直通动作处理器（处理器自有 ToolError） | 降级直通 |
| 进程重启 | 内存缓存清零（会话级缓存，无持久化面） | 设计内 |

## 5. 断言锚

- **probe-caps**：CACHE-01..06 专组——CACHE-01 首探全量/同参折存根（stub 键面预排序断言）、CACHE-02 三动作可缓存+db.query 显式排除、CACHE-03 no_cache 恒全量零残留+schema 增参、CACHE-04 续页不读写缓存（误写被首页存根 prior_hash 当场抓获）——tests/suites/probe-caps.mjs。
- **LM-05**（lint-manifest，M1-3 注册）：PROBE_CACHE_ACTIONS/PROBE_CACHE_MAX_ENTRIES/probeCacheKey/probeCacheStub 等 server.mjs grep 可见+本文存在非空。

## 6. 维护规则

- 新增可缓存动作：PROBE_CACHE_ACTIONS 增项+本文 §1 准入门+probe-caps CACHE 组断言三件同波；**外部可变数据源动作默认出列**（db.query 先例——mtime 不可信即不设缓存）。
- 键形状变更=缓存语义变更：需同步 page_token sz 绑定哲学说明与 CACHE 断言组；禁止把 payload 塞进存根（省字节前提，不留妥协口）。
- 容量调整（64）：改动需复算总帽（条数×10KB）并在本文 §3 落字面；probe-caps 若锁字面值同波改。
