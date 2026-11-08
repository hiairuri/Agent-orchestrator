// @module crv8-memory
/*!
 * suites/crv8-memory.mjs —— v0.8 记忆子系统 suite（W1 bootstrap：P0 分发端补门 INJ 族；
 *   W2 增例：两级库与捎带面 SYNC/GLEAN/INJ-06b 族；W3 增例：ORCHTEMP 与锁 GLEAN-03/05 族）
 *
 * 覆盖断言组（断言主句权威 = tests/assertions/v0.8.x.md；v0.9 增例权威 =
 *   tests/assertions/v0.9.x.md；设计权威 = v0.8-DESIGN §3/§4/§5/§6/§7/§14 +
 *   v0.9-DESIGN §10 C5/§15 W1）：
 *   A-v080-INJ-01（§3.1 type 加权不滤除：error-fix 单类命中入选 + 同 overlap 等分时
 *     error-fix 以 LESSON_TYPE_WEIGHT 排在 pitfall 前，任何 type 不被滤除）
 *   A-v080-INJ-02（§3.2 INJECT_MIN_SCORE=0.40 阈值门：原始衰减持 score<0.40 不入选
 *     〔同 overlap 对照 fixture，排除面只归阈值〕；常量默认值锁定——server.mjs 子串 +
 *     断言登记文件双文件 grep 防漂移，沿 CFG-05 先例）
 *   A-v080-INJ-03（§3.3 id 渲染：lessonLine 含 [type·id] 段且每行增量 ≤24B；
 *     无命中/空库整节不出现性质回归 = CR-04「参数缺省时节整体不出现」）
 *   A-v080-INJ-04（§3.4 lesson_refs 降权闭环：report(blocked, lesson_refs) →
 *     confidence −0.1 下限 0.1 + counter_refs 记 mission（去重）+ 未知 id 跳过带注；
 *     触底（confidence=0.1）且 ≥2 个 mission 回引 → housekeep 置 retired
 *     note="auto: lesson misses"）
 *   A-v080-INJ-05（§3.4 兼容守卫：无 lesson_refs / 非数组 / 无意义 kind（done）携带 →
 *     整体忽略，库零变化，旧 worker 零变化）
 *   A-v080-INJ-06a（§3.5 scope+source 字段：add 写 scope="project"/source="add"、
 *     report 候选写 source="report"；读端容忍——缺 scope 存量行照常入选（缺省 project
 *     语义）、未知字段不炸）
 *   A-v080-INJ-06b（W2，§3.5 双库读端：双库合并选材 + normKey 去重全端优先（同
 *     merge key 的项目孪生被全端条目遮蔽、恰渲染一次）+ contradicts 不跨库（全端 id
 *     项目库寻址失败、全端库字节零变化）；场景内附 §7.2 全端节三腿（注入/节序/
 *     pack_global_section 开关，无独立 §14 ID，随本场景施工））
 *   A-v080-INJ-07（§3.6 死码清理：server.mjs grep topLessonsBrief/BRIEF_TOP_K/
 *     BRIEF_MAX_CHARS 零命中；session-start lessons digest 注释无悬空「twin of
 *     server.mjs」字样且本地副本实现仍在）
 *   A-v080-INJ-08（CR-04 性质锁：无全端库+无任一视图 ORCH.md 的临时根下 context_pack
 *     输出与 0.7.1 基线（git f0142a8）逐字节一致〔v1.7.0 W1 注记同步——双视图落点：
 *     项目视图=项目根、全端视图=fleet 根〕；含 LESSONS 命中场景时唯一预期增量=id 段
 *     （归一化后逐字节）。W2 起 0.8 侧随 --memory-root 注入空全端目录环境重跑）
 *   A-v080-SYNC-01..05（W2，§4 ver 同步捎带族：首读 initial 全文（文件不存在时不附
 *     基线=absent）/外部改写 changed+ver 递增/stat 未变零开销无键/超 120 行截断
 *     truncated:true+提示行/删除 removed 恰一次后安静）
 *   A-v080-GLEAN-01（W2，§6.1 门槛纯函数：双门槛真值表（时间门必要+事件门必要）
 *     +成本排序（源码序断言：时间比较先于事件计数、事件计数先于锁仲裁））
 *   A-v080-GLEAN-02（W2，§6.1/§9.2 到期信号：双门过 → due:true+reason+brief_path+
 *     lock_state=idle；锁 active 活 PID → 只附 lock_state=busy 无 due 键且不物化 brief）
 *   A-v080-GLEAN-04（W2，§9.2 glean-brief.json 物化字段齐全：v/generated_at/root_id/
 *     project_path/gate（含 measured）/watermarks/orchtemp_pending/counts/projects/
 *     orch_md/cfg）
 *   A-v080-GLEAN-06（W2，§6.6 项目名册：启动 upsert 恰一行（五字段齐全）/复见原地
 *     更新 last_seen 不重复行且 first_seen 保留/异 root 追加/带锁（源码序 + 活 PID
 *     占锁时 best-effort 零变化行为腿）/--memory-root 注入生效（不落缺省重定向））
 *   A-v080-GLEAN-03（W3，§6.4/§9.3 归敛锁状态机全腿：wx 抢锁原子（EEXIST 互斥）/
 *     活 PID 占用拒接管（busy 即退零阻塞）/死 PID 回收/绝对过期 1.5h 回收 +
 *     cfg.lock_stale_hours 覆盖接线/done 态保留且 finished_at 优先、mtime 兜底
 *     （mtime 双用）/两锁不互嵌源码面（server 对归敛锁只读判锁）/cfg junk 逐键兜底）
 *   A-v0110-M10-01（M10 G12，board/list glean_due 信号入 result JSON 内部：due →
 *     顶层 glean_due {idle_h,events,brief_path} 且同调用内 brief 物化可达/时间门·
 *     事件门·busy 三无 due 腿键整体缺省（零字节差缺省，P9-01 体例）；顶层 orch_memory
 *     附件保留不拆。设计权威 designs/agent-orchestrator-prompt-opt-20261024.md + G12
 *     双实证（主控+gleaner）；断言主句权威 tests/assertions/v0.11.x.md §1）
 *   A-v0110-GLEAN3-01（glean3 微波，m-20261025-012000-glean3；v1.7.0 W1 头注同步——
 *     固定包 READ FIRST persona 路径行已随 OPEN-5 清偿删除，G13 钉面随之移除该锚）：
 *     server 物化固定
 *     glean-pack.md 主控零组装——gate due 同调用点随 brief 再生（brief 物化后组合）；
 *     due 信号两 surfacing 均增 pack_path（orch_memory.glean + board/list glean_due）；
 *     固定模板锚（锁权威指针勿手写/四态口径/视图层
 *     边界/日志纪律 reports/<ts>-glean.md/Return ≤3 行指针纪律）+ brief 逐字内嵌
 *     （brief 文件字节 ⊂ pack 字节）；brief+pack 删除后 board/list 单调用双重建；
 *     busy 不重写 pack（零写面）；无 due 不物化 pack（零字节差缺省，P9-01 体例）。
 *     断言主句权威 tests/assertions/v0.11.x.md §1）
 *   A-v080-GLEAN-05（W3，§5 stage 写入形状与 ORCHTEMP 候选流转：source=
 *     orchestrator/candidate/conf=0/hits=0 + note 摆放提示 + escape 先于截断 +
 *     type 缺省 pitfall/坏 type 空 trigger 严格报错/不做 findMergeTarget 合并/
 *     candidate 不参与注入（纯 stage 库 LESSONS 整节不出现）/brief.orchtemp_pending
 *     恰含 stage 条（report 候选不入）/retire 消费置状态内容逐字节不变/§9.4 schema
 *     描述行逐字在案）
 *   A-v080-GLEAN-07（W5，§6.7 promote target=global：晋升标准两分支证据随响应
 *     （跨项目复现≥2〔名册 sibling 库同 normKey 含 candidate〕/单库强条
 *     score≥0.7∧hits≥3∧龄≥7d）+ 全端 findMergeTarget 合并/新建两腿（scope=global/
 *     source=promote/conf 0.7/hits 1）+ refs 回链三元组〔源条 id, 源项目路径,
 *     root_id〕+ 项目库源条逐字节原地不动 + 缺省 target=project 现行为零变化 +
 *     坏 target 严格报错 + schema 枚举在案；标准证据非 server 门——判定权在归敛
 *     〔§6.7「归敛自行判定并在报告列证据」，偏差声明见断言文件 §0 W5 条〕）
 *   A-v080-GLEAN-08（W5，§3.5/§6.7 双库去重终验（晋升场景）：promote 后同 normKey
 *     项目源条被全端新条遮蔽（源 id 不渲染、晋升 id 恰渲染一次）+ 晋升后注入可见
 *     （pack LESSONS 渲染全端新条）+ 读端零写（两库字节零变化））
 *
 *   A-v090-THR-01（v0.9 W1，C5 阈值落值：INJECT_MIN_SCORE 0.40→0.39——新值行为生效
 *     对照〔判别行 score≈0.395∈[0.39,0.40) 入选，0.40 口径下必被排除〕+ 落门/入选
 *     对照更新（OLD≈0.158<0.39 落门、FRESH 0.60 入选）+ 推导注记 v0.9 复算版在案
 *     （P25=0.4583 ×0.85 圆整 0.39、界 [0.30,0.50]）；断言主句权威 = v0.9.x.md。
 *     INJ-02 常量锁登记面随之改钉 v0.9.x.md（0.39 口径；v0.8.x.md 为 0.8 期历史
 *     记录，不在本波写集））
 *   A-v090-REG-01（v0.9 W3，C7 registry library_path + sibling 扫描两腿：登记行含
 *     library_path=本实例实际解析项目库绝对路径/自定义 --root sibling 自登记可见且
 *     经 library_path 优先腿端到端命中 cross-project count=2（默认布局映射下不可见）/
 *     无 library_path 存量行回退默认布局命中（回退腿，兼容守卫）；断言主句权威 =
 *     v0.9.x.md；设计权威 = v0.9-DESIGN §9 C7）
 *   A-v090-HOST-01b（v0.9 W3 条件腿，C6 双注入证实触发：宿主用户级注入面源码复核
 *     结论=存在〔~/.zcode/AGENTS.md，scope="user"，designs/agent-orchestrator-v0.9-C6-
 *     findings.md〕→ readGleanCfg 缺省 pack_global_section false（cfg 键翻转锁：源码
 *     字面量 grep + 无 cfg 缺省关行为腿）；全端节 SEC72-a 改显式 opt-in（cfg true），
 *     GLEAN-03g junk 回落值随缺省翻转为 false；设计权威 = v0.9-DESIGN §8/§16）
 *   A-v090-W3FIX（v0.9 W3fix，m-20261022-180233-3051：saveGlobalLessons base 修复
 *     回归——显式 --memory-root 指向项目根外（生产缺省 ~/.zcode/orchestrator-memory
 *     同位）时 promote target=global 端到端成功〔原炸点「path escapes base directory」
 *     转绿：新建/合并两写腿〕+ 源条原地不动红线在根外场景同守；断言主句权威 =
 *     v0.9.x.md〔登记归主控补，不在本波写集〕；设计权威 = v0.8-DESIGN §6.7）
 *
 * W2 落位注记：全端库缺省 ~/.zcode/orchestrator-memory；suite 临时根（os.tmpdir() 下）
 *   的缺省重定向=<临时根>/orchestrator-memory（root.txt「test root must not stick」同族
 *   刻出，防套件污染真实家目录）——SYNC/GLEAN-01/02/04/INJ-06b 场景即用该缺省落点布景，
 *   GLEAN-06 场景经 --memory-root 显式注入另测。
 *
 * v0.10 G2 稳定化（m-20261024-032310-bf22）：GLEAN-02b/03b/03c/03d 直写 glean 锁后
 *   加 server 侧读回屏障（glean 键对 server 可见再断言）——NTFS mtime 可略超前
 *   Date.now()（本机实测 -10ms 量级），idle_hours=0 的严格 `idleH > 0` 时间门首读
 *   偶落空（与 ENV-06a「直写 now 被判未来」同族）；SYNC-02 两次同尺寸改写间加 100ms
 *   时序余量（mtime 时钟粒度 ~15.6ms，同跳则双因子判不出 changed，CACHE-06a 同族）。
 *   两处均只改观测时序，断言主句零改动（只增屏障代码，不增删断言）。
 *
 * 运行方式：node tests/suites/crv8-memory.mjs [--root <临时根父目录>]
 * 前置：node >= 20；PATH 上有 git（INJ-08 基线导出）；无网。suite 注册行归主控
 *   G 胶水波收口（run-all REGISTRY，§13.2）——本套未注册前 run-all 不含其断言属预期。
 *
 * v1.3 W1 巨型文件拆分（用户 2026-11-01 裁定）：断言主体按功能块拆入 crv8-memory/
 *   子目录（shared 夹具单例 + 8 个场景模块），本文件保留为薄入口——聚合执行全部
 *   场景（调用序=拆前场景块序，零行为变更，SUITE 摘要行格式与断言总数不变）：
 *   injection（INJ-01..08+THR-01）/ sync（SYNC-01..05＋W2 SYNC-06..09）/ glean-gate
 *   （GLEAN-01/02/04+G12+G13）/ glean-lock（GLEAN-03/06）/ stage（GLEAN-05+promote_batch）/
 *   global-promote（INJ-06b+HOST-01b+SEC72+GLEAN-07/08）/ reglib（REG-01+W3FIX）/
 *   digest（W3-DG+W6-P2a+STL；v1.6 W3a 整退役——R4/R6 digest pack 面渲染管线退役，
 *   subject 消亡清账；台账 v1.6.0.md §W3a）。
 *
 * v1.3 W2（m-20261101-084937-93b2）：sync 新增场景 6b SYNC-06..09——content 面第三
 *   surfacing（server handleToolsCall 注入 result 顶层 orch_md 键；design §3.2；
 *   SYNC-06 initial 全文可达/SYNC-07 changed 新全文+ver 递增/SYNC-08 unchanged
 *   无键零字节差/SYNC-09 removed 单行恰一次后安静；断言台账 v1.3.0.md W2 节）。
 *
 * v1.3 W3（m-20261101-090133-fb0b）：glean-gate 场景 8 内 GLEAN-04d 扩臂三态（brief.views
 *   块五字段只读快照：全缺/半缺/全在，marker 字段=项目根标记对语义钉死；design §3.3
 *   信号腿）＋injection 场景 5 子例 C（INJ-08e/f 负判据新验证腿：due 物化 mkdir 兜底
 *   只建目录不建文件＋注入面仍与 0.7.1 字节等价；断言台账 v1.3.0.md W3 节）。
 *
 * v1.3 W4（m-20261101-092058-713a）：sync 新增场景 6c SYNC-15..21——帽张力 cfg 化
 *   opt-in（server readGleanCfg 增 orch_md_max_lines/orch_md_max_bytes 两键、
 *   orchMdAttachment 消费 cfg+提示动态化、固定包 RULES 帽值句动态渲染、L-9 单次
 *   cfg 读贯穿两腿禁进程级缓存；design §3.4；SYNC-15 默认字节等价回归/SYNC-16..17
 *   帽两键 junk 回落/SYNC-18 生效腿/SYNC-19 提示动态字面/SYNC-20..21 pack 渲染
 *   默认+上调臂；断言台账 v1.3.0.md W4 节）。
 *
 * v1.6 W-t（m-20261104-033000-w16-t）：新增场景 17 trajectory（crv8-memory/trajectory.mjs）——
 *   trajectory 写面（第 13 号工具，N15① cap 行为/协议行 server 铸/滞回裁回/超帽 isError/ORT 逐字
 *   +flying 补全/短形 server 侧合并/跨会话 seq 单调；断言台账 v1.6.0.md W-t 节）。
 *
 * v1.6 W4（m-20261105-053000-w16-4）：新增场景 18 lessons-hash（crv8-memory/lessons-hash.mjs）——
 *   lessons 哈希读面+token 写闸（design §2.4/§3.3 N4：哈希三腿〔无新短答/有新增量/基线前滚幂等〕
 *   +写闸负向双支〔携 token 五写 action 一律拒〕+反向钉伴腿〔无 token 全功能不变/首调建基线 state
 *   落位/第二 reader 独立基线〕；断言台账 v1.6.0.md W4 节）。
 *
 * v1.7.0 W1（m-20261109-013922-9277，记忆与召回体系重构双视图波；impl-plan r2 §2.1.B+I 行）：
 *   ①sync 场景 6 N9 扩双视图（Q10-07：项目/全端两视图各三态生命周期采样）+场景 6c 增
 *   SYNC-22/23（Q10-05 全端帽键 fleet_orch_md_max_lines/_bytes cfg 渲染+junk 回落）；
 *   ②glean-gate 场景 8 GLEAN-04d 三态重基双视图键族（Q10-03，O-3 直改：orch_md_*=项目视图/
 *   fleet_orch_md_*=全端视图；退役键 global_agents_md_exists/agents_md_marker_exists）+
 *   G13 钉面重基（persona 路径钉随 server-memory READ FIRST 删行移除，13→14 钉——增分域判据句/
 *   第四视图句两钉）+G13-e2/e3 新腿（Q10-05 双帽句默认渲染+Q10-06 双开关句）；
 *   ③global-promote 场景 12 夹具/源码锁随源切换重基（GLOBAL MEMORY 注入源=全端视图 ORCH.md
 *   +readGleanCfg defaults 字面量随 fleet 帽两键扩位重钉——J 步差集 G1/G2）；
 *   ④injection 场景 5 INJ-08e 空壳负向扩全端视图（J 步差集 G3）+场景注记双视图词汇；
 *   ⑤stage 场景 11 reason 字面随场景改双视图域词汇。断言台账 tests/assertions/v1.7.0.md。

 */
import { ck, BASE } from "./crv8-memory/shared.mjs";
import { scenInj01to06a, scenInj02, scenThr01, scenInj04_05, scenInj07, scenInj08 } from "./crv8-memory/injection.mjs";
import { scenSync01to05, scenSync06to09, scenSyncW4Caps } from "./crv8-memory/sync.mjs";
import { scenGlean01, scenGlean02_04 } from "./crv8-memory/glean-gate.mjs";
import { scenGlean06, scenGlean03 } from "./crv8-memory/glean-lock.mjs";
import { scenGlean05, scenPromoteBatch } from "./crv8-memory/stage.mjs";
import { scenInj06bHost, scenGlean07_08 } from "./crv8-memory/global-promote.mjs";
import { scenReg01, scenW3fix } from "./crv8-memory/reglib.mjs";
import { scenTrajectory } from "./crv8-memory/trajectory.mjs";
import { scenLessonsHash } from "./crv8-memory/lessons-hash.mjs";

// 场景执行序 = 拆前场景块序（ck 输出顺序零变化）：
await scenInj01to06a(); // 场景 1：INJ-01/INJ-03/INJ-06a
await scenInj02(); // 场景 2：INJ-02
await scenThr01(); // 场景 2b：THR-01
await scenInj04_05(); // 场景 3：INJ-04/INJ-05
await scenInj07(); // 场景 4：INJ-07
await scenInj08(); // 场景 5：INJ-08
await scenSync01to05(); // 场景 6：SYNC-01..05
await scenSync06to09(); // 场景 6b：SYNC-06..09（v1.3 W2 content 面第三 surfacing）
await scenSyncW4Caps(); // 场景 6c：SYNC-15..21（v1.3 W4 帽张力 cfg 化 opt-in）
await scenGlean01(); // 场景 7：GLEAN-01
await scenGlean02_04(); // 场景 8：GLEAN-02 + GLEAN-04
await scenGlean06(); // 场景 9：GLEAN-06
await scenGlean03(); // 场景 10：GLEAN-03
await scenGlean05(); // 场景 11：GLEAN-05
await scenPromoteBatch(); // 场景 11b：GLEAN-05l..q
await scenInj06bHost(); // INJ-06b + HOST-01b + §7.2
await scenGlean07_08(); // 场景 13：GLEAN-07/08
await scenReg01(); // 场景 14：REG-01
await scenW3fix(); // 场景 15：W3FIX
await scenTrajectory(); // 场景 17：trajectory 写面（v1.6 W-t N15①）
await scenLessonsHash(); // 场景 18：lessons 哈希读面+token 写闸（v1.6 W4 N4）

BASE.cleanup();
const { fail } = ck.summary();
process.exit(fail ? 1 : 0);
