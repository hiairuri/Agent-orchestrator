// @module sentinel-teardown
/*!
 * suites/sentinel-teardown.mjs —— 哨兵 v2.1 待命制 + 寿命轮换选举（bg-sentinel.mjs 黑盒，加速参数驱动）
 *
 * 覆盖断言组（v0.5.1 全清零唤醒改造：平台把任何后台退出都变成完成通知，全清三实例三连唤属缺陷）：
 *   T1 全清待命不退（观察窗存活 + state=standby + 心跳续刷 + 零回声零 fired + 待命期板不可读静默续待命）
 *   T2 板面复活（新在飞 → state=active；未签收 → 复活后告警照旧 exit 1 + echo/fired + 槽位释放）
 *   T3 寿命 cap 单赢家选举（3 实例：到期前零退出；退出全 0 带轮换文案；相邻退出间隔 ≥ 寿命刻度；
 *      family-teardown 标记随最后赢家更新；轮换零告警副作用）
 *   T4 标记/槽位容错与混跑兼容（陈旧标记夺位、损坏标记修复、新鲜标记顺延、旧格式槽位共存）
 *   T5 V6-32 板面龄期反证（C3 开枪前双陈旧反证：活板真崩溃照旧绕门 crash；
 *      lastActivity 与 board mtime 双陈旧 → 降级 C2 受双空闲门 stall，加速参数驱动）
 *   T6 V6-54/V6-55（B4 末波）：claimShots 文件名去 pid 恢复同名 wx 互斥（固定时钟
 *      单元级，剥入口导入）+ touchSlot 前 pid 归属校验（他人槽位让位；黑盒集成：
 *      被接管实例持续让位退为无槽幽灵）
 *   T7 V7-08（WS-1..3）：R1 standby mtime 门（板写 ≤3s 复活 active，修前需 ~300s；
 *      mtime 未变 10×poll 维持 standby 且 fired/echo 零新增防评估放大）+ R2 让位
 *      明示一行（满编 + running → 第 4 实例 exit 0 ∧ stdout 含「让位」「自动接管」）
 *   T8 V7-04 lite（WS-5..6）：观测型隔离——C0 板不可读满 cap 三实例转 quarantined
 *      零退出、quarantine.json 恰一份（wx 仲裁）+ 聚合告警恰一条（家族级抑制）；
 *      板恢复可读 → 共享 mtime 门 ≤3s 自愈（标记被清回 standby/active）+ 告警面
 *      恢复（未签收条件照旧开枪恰 1 实例）；新鲜标记期内新条件不触发 fired、
 *      超 cap_window 后抑制解除照旧开枪 + 陈旧标记被清
 *   T9 V7-06（WS-8..9，v0.7-A3）：board list 的 sentinel_health 三态聚合——空目录=无哨兵；
 *      混编（fresh standby + stale）逐实例分类正确且 summary 归在岗待命（可补员=无任何
 *      存活实例，含 stale 不误判）；全死槽=可补员；quarantined 第三态认得且归在岗
 *      （隔离值守）；板全清全 fresh standby=在岗待命（自动接管新派发）
 *   T10 W6 WAKE 族（v0.8-DESIGN §13.1 W6 / §14 A-v080-WAKE-01..03）：bg-sentinel 消费
 *      <sentinel>/watcher-signals.jsonl（格式实证=watcher/degrade.mjs #writeSignal）——
 *      WAKE-01 最新有效信号 cls=D2 且新鲜 → C1 两族静默零开枪，信号过期 → 既有兜底
 *      恢复；WAKE-02 信号缺失 → 兜底路径不回归（既有唤醒失败告警保持）；WAKE-03
 *      stall 死寂检测无条件保留（fresh D2 覆盖在位下 inflight_stall 照旧开枪——watcher
 *      事件中继看不见无事件死寂，C2 面不随降级关闭，2026-10-22 用户裁决）
 *   T11 CLN-05（v0.9 C8）：writeSentinelCfg 全 sparse cfg 形状——无 argv 启动 cfg 仅含
 *      signals 块（v2 十键+桥四键全缺省）、显式单键仅该键+signals（黑盒 spawn server
 *      两腿）+零漂移对拍锁（server 十键 numArgOpt 无 numArg 遗留 ∧ 哨兵内建默认字面量
 *      表逐条在位 ∧ 对拍表登记 v0.9.x.md）
 *   T12 W4 A1（v1.1；v1.1.1 W20 日志化重构）：stop-check coord-tail 追加日志黑盒——
 *      v2 双标签（`<!-- orch-tail v2` + `<!-- orch-tail-end -->`，成对/最后一组完整对/
 *      尾锚定）→ `<存储根>/context/coord-tail-log.md` 逐字追加（含 ts:/seq:，块间空行，
 *      无文件头）。T12-a..k 改靶保留（无标记零写/全形追加/短形 delta/飞名单边界/超帽/
 *      未知字段/subagent 前缀/缺基线/多块取末）；T12-w/x 锁 v1 块零触发与尾锚定；
 *      T12-o/p 变化即追加+同内容幂等（stop_hook_active 重入）；T12-q 封顶改写为滞回裁剪腿
 *      （v1.2.2 20/10：第 21 块触发原子重写留最新 10）+ HYS-01 累积腿/HYS-02 单写触发腿；
 *      T12-r 旧 v1 seed 幂等+三遗留清理；T12-s 跨会话追加无冻结（append 无判旧正面锁）；
 *      T12-t 坏条目容错；T12-u 写失败 fail-safe；T12-v/v2 祖先回退命中与默认根合法性优先。
 *      （T12-h 判旧腿与 T12-n ts 时刻守卫腿随「append 无判旧」结构性删除；T12-l/m 改造并入
 *      T12-s/T12-r。）
 *   M9-1 SCP/REV 组（v1.2，A-v0120-SCP/REV）：SCP-a 他会话零开枪+静默留痕 / SCP-b 空值
 *      三段 / REV-③ 补告警 / REV-④ O10 协同 / REV-⑤⑦ 组包尾块缺席计数 / REV-⑥⑦ 触发面②
 *      端到端。
 *
 * live 行为无法自动化的部分（手动验收步骤）：
 *   - 平台通知面：全清后主控 0 唤醒（旧版实测三实例三连唤）——需宿主后台任务真跑 3 实例
 *     （node hooks/bg-sentinel.mjs --once × 3, run_in_background=true）观察完成通知数量为 0。
 *   - 真实 24h 寿命轮换节奏（每 24h 至多 1 条轮换通知）——--max-lifetime-min 1440 观察 24h+，
 *     确认只收到 1 条"家族轮换"通知且其余实例仍在岗（槽位 state=standby/active）。
 *   - bg-gate 补员提醒在 standby 家族常驻时的抑制——直核：家族 standby 后发一次后台派发，
 *     确认 bg-gate 输出无"拉起哨兵"句（本套件以 T1b 心跳新鲜度间接覆盖在岗判定）。
 *
 * 拆分结构（v1.3 初步切分；断言本体逐字搬运零改动，本文件为薄入口=常量+ctx 组装+顺序执行+收尾）：
 *   sentinel-teardown/fixtures.mjs    共享夹具与辅助（sleep/waitFor/readJson/readText/countLines/
 *                                     slotFile/SID/writeAnchor/writeBoard/spawnSentinel/
 *                                     writeMarker + cleanSlots/firedCount）
 *   sentinel-teardown/t1-t3.mjs       T1 全清待命 + T2 板面复活 + T3 寿命轮换选举
 *   sentinel-teardown/t4-t6.mjs       T4 容错混跑 + T5 龄期反证 + T6 互斥/接管
 *   sentinel-teardown/t7-t8.mjs       T7 mtime 门/让位明示 + T8 观测型隔离
 *   sentinel-teardown/t9-t10.mjs      T9 sentinel_health 聚合 + T10 W6 WAKE 族
 *   sentinel-teardown/t11-t12.mjs     T11 CLN-05 sparse cfg + T12 coord-tail 日志黑盒
 *   sentinel-teardown/m91-scp-rev.mjs v1.2 M9-1 SCP/REV 组
 *
 * 运行方式：node tests/suites/sentinel-teardown.mjs
 * 前置：node >= 20；无 git/网络依赖；总时长 ~110s（全部加速参数驱动， Windows/linux 均可）。
 */
import path from "node:path";
import { PLUGIN_DIR, Checker } from "../harness/jsonrpc-client.mjs";
import { makeTempRoot } from "../harness/temp-root.mjs";
import { createFixtures } from "./sentinel-teardown/fixtures.mjs";
import * as t1t3 from "./sentinel-teardown/t1-t3.mjs";
import * as t4t6 from "./sentinel-teardown/t4-t6.mjs";
import * as t7t8 from "./sentinel-teardown/t7-t8.mjs";
import * as t9t10 from "./sentinel-teardown/t9-t10.mjs";
import * as t11t12 from "./sentinel-teardown/t11-t12.mjs";
import * as m91 from "./sentinel-teardown/m91-scp-rev.mjs";

const ck = new Checker("sentinel-teardown");
const SENTINEL = path.join(PLUGIN_DIR, "hooks", "bg-sentinel.mjs");
const STOP_CHECK = path.join(PLUGIN_DIR, "hooks", "stop-check.mjs");
const BASE = makeTempRoot({ prefix: "orch-sentd-" });
const PROJ = path.join(BASE.root, "proj");
const ROOT = path.join(PROJ, ".zcode", "orchestrator");
const SENT_DIR = path.join(ROOT, "sentinel");
const MARKER = path.join(SENT_DIR, "family-teardown.json");
const ECHO = path.join(SENT_DIR, "echo.jsonl");

const kids = [];

const ctx = {
  ck, PLUGIN_DIR, SENTINEL, STOP_CHECK, BASE, PROJ, ROOT, SENT_DIR, MARKER, ECHO, kids,
  ...createFixtures({ SENTINEL, PROJ, ROOT, SENT_DIR, MARKER, ECHO, kids }),
};
const { sleep } = ctx;

try {
  await t1t3.run(ctx); // T1 全清待命 / T2 板面复活 / T3 寿命轮换选举
  await t4t6.run(ctx); // T4 容错混跑 / T5 龄期反证 / T6 互斥/接管
  await t7t8.run(ctx); // T7 mtime 门/让位明示 / T8 观测型隔离
  await t9t10.run(ctx); // T9 sentinel_health 聚合 / T10 W6 WAKE 族
  await t11t12.run(ctx); // T11 CLN-05 sparse cfg / T12 coord-tail 日志黑盒
  await m91.run(ctx); // v1.2 M9-1 SCP/REV 组
} finally {
  for (const k of kids) {
    try {
      k.kill();
    } catch {
      /* already gone */
    }
  }
  await sleep(400);
  BASE.cleanup();
}
const { fail } = ck.summary();
process.exit(fail ? 1 : 0);
