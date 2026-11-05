// @module watcher-core
/*!
 * suites/watcher-core.mjs —— W1 watcher 守护进程核心套（mock relay + mock 凭据，零真实触达）
 *
 * 覆盖断言组（v0.7-W1；权威设计=designs/agent-orchestrator-v0.7-W-W-findings.md + W-G + EXP-3）：
 *   W-RED  REDACTED 日志闸（token 形态/Bearer 归零 + 自检；W-W §5.5 对账锚）
 *   W-POL  POLLER 分类（classify twin：未签收终态两族/优先级/宽限/签收排除/workflow 排除/
 *          B5 mtime 备链/spool 只数）
 *   W-TXN  TXN 闸（≥90s 频控/cap=3/D2 指数退避/busy×2 静默 30min/nextEligibleAt）
 *   W-TTL  TTL 签-连（≤55s 同事务/超窗弃签重签恰一次/再败 ttl-exhausted→D1 面）
 *   W-CRD  CREDS（AES-256-GCM roundtrip/坏 tag 安全失败/JWT 形态自检无 exp 不判过期/
 *          S0-S3 链 safeParse/401→auth-required/token 正则/设备拣选）
 *   W-RLY  RELAY V2（auth 闸 matched/KICKED 静默互踢第一禁令/关断码映射全表/噪声 data 计数
 *          不解析/awaitData 匹配）
 *   W-BRG  BRIDGE（crc32 IEEE 向量/04D-3 rpc-frame roundtrip/checksum/分片/限值/L2 编排+空列表；
 *          v0.10 W3 基线修订：04D-3 形状+bridgeSessionId 终端自造+ready 深消费）
 *   W-REG  REG 级形状钉（v0.9-L2：L2 语义装 data.payload 内层/requestId 字段名/
 *          workspaceKey 派生消费=workspaceIdentity.trim||workspacePath+activeWorkspaceKey 兜底/
 *          出站 type 白名单/scheme 闸）
 *   W-BRG2 wake 链 04D-3（v0.10 W3：openBridge 深形——自造 id/回显/identity 透传/initialTaskId
 *          深读/error 快路径；ack 回程生死项——重放窗释放/saturated/replayBufferExceeded→
 *          bridge-degraded/reason 枚举全表）
 *   W-INJ  INJECT（模板壳定案/隐私纪律/单行/200 字夹紧/sendPrompt 频道调用面；W3r：参数
 *          schema L4 定案——payload 直传/issuedAt 数字/keepQueueAndSend/b2 createSession 构建器）
 *   W-INJ2 内层编码器（v0.10 W3：VQL 字节向量锁/ChannelClient Initialize [200] 闸/请求 id
 *          匹配/ready 前零 rpc 帧；W3r：G4 Int 值域/G5 dispose fail-closed；W3s：G8 连接握手
 *          序列/clientHello strict 形状/恰一次随连接生命周期/失败面/超时面/lastRejection 留痕；
 *          G3：G9 位置参数组锁——三处 call 第三参=数组（hello=[]/initialize=[clientHello]/命令=[params]））
 *   W-WSA  工作区锚钉（v0.10 G3 G10；G5 基线修订：无锚 bridge-anchor-missing / 锚未命中
 *          bridge-anchor-mismatch 均 fail-loud，禁止盲取 workspaces[0]；锚匹配三面归一；
 *          allowLegacyFirst 显式逃生口；watcher 只读锚不写锚）
 *   W-RESP watcher respP 潜伏面（v0.10 G2 平移自 watcher-shim，主句零改动）：guardPendingResponse
 *          对拒绝 promise 恒消费（零 unhandledRejection）+ 显式 await 仍收拒绝 + 成功值透传 +
 *          watcher.mjs 源面接线锁（sendPrompt 失败路径不留裸挂起 promise）
 *   C11    coord-session 自愈（v0.10 W3：b2 stale→新建会话重试恰一次→原子刷新；b1 活体零重写；
 *          OPEN-10.4 无 sessionId 不刷新；W3r：b2=createSession+firstInput 线上形状+CLI 层
 *          触发面宽匹配 callP rejection/ack rejected+负控制；G3：workspaceKeyHint 透传+
 *          RESP_TIMEOUT_MS 冷启覆盖常量锁；G5：刷新前工作区守卫）
 *   G4     b2 生产接线+锚互信根（v0.10 G4：watcher 主路径切 wakeCoordSession——mock 全链
 *          b2 自愈+coord-session 刷新+锚保持；源面调用锁；toolResume 双写 coord-workspace 锚；
 *          G5：server 启动补位 + b2 刷新工作区守卫（错/未验证工作区不刷新、warning 落日志））
 *   G5    锚互信根触发（v0.10 G5：SessionStart 无条件成对重发布 session+workspace 锚（R4
 *          重启后 coord-workspace 缺失的根因修复）+session_id 消毒+三触发面源锁+D3 归类）
 *   G14   锚重发布子代理过滤（v0.10 G14：子代理会话 id → publishWakeAnchor 入口跳过，
 *          锚零写+存量锚零触碰；主控 id 成对写不误伤；EXP10-findings R6 重启恢复实锤）
 *   WA0   托管 worker 锚写面身份鉴别（v1.1.1 W-A0：ORCH_MANAGED_WORKER env 在场 →
 *          publishWakeAnchor 入口跳过零写；无 env 照常发布 A/B 对照；源面钉；锚劫持
 *          活体实证 2026-10-25 -p 探针会话）
 *   WB-RUN runner 生产者（v1.1.1 W-B：runner spawn CLI 落 ORCH_MANAGED_WORKER env 黑盒 +
 *          收 result 出口 wake-queue 逐事件单文件 + 认领 spawn 释放链 + 源面钉）
 *   W2    B1 锚自愈三面 + C3 rider（v1.1 W2）：锚消费面前置形状校验（sess_subagent 拒用
 *          fail-loud/零帧）、唤醒前存活性判别（D3 拒用路径/主控不误伤）、toolResume 子代理
 *          零写拒绝、watcher.mjs 真实 eventId 生产接线（latestUnreadEventId）
 *   W-VRD  VERDICT（三证合一矩阵/busy=noop/③复活观测窗）
 *   W-DGR  DEGRADE（降级树全表 D1-D3/kicked/signals 落盘+滚动+脱敏）
 *   W-E2E  全链 e2e（mock relay+mock 凭据：success/noop-busy×2 静默/kicked 断路/D1 凭据缺失/
 *          D3 coord-session 缺失/D2 建连败退避/hold-cap 40s 面修订为 1s 加速）
 *   W-WS   ws.mjs RFC6455 codec（掩码 roundtrip/分片重装/64 位长度/ping/close/upgrade 形状/
 *          RFC 6455 §1.3 accept 向量）
 *   WB-KICK 完成即唤执行器消费逻辑（v1.1.1 W-B 二波，hooks/wake-kick.mjs）：drain 合并
 *          ≤12+计数行/毒丸 quarantine 跳过/锚活性双闸（形状+rollout mtime 10min）/
 *          refire gap 告警抑制/溢出分批留队/b2 后置防线（锚快照还原+anchor-rewritten 失败
 *          留队+源面零 wakeCoordSession 钉）/signals 快照还原（C1 兜底不掩盖）/认领串行化
 *          （kick 让位/生产者窗重试/陈旧残留回收）/CLI 黑盒
 *   WB-SENT 哨兵 drain（bg-sentinel 滞留消费黑盒）：滞留件→spawn kick（last-spawn 标记+
 *          kick 锚闸告警落地）/认领新鲜持有→跳过/陈旧残留→spawn+kick 回收/C1 兜底不破坏
 *          （同 tick 双效应：开枪照旧 + drain 补脚）
 *
 * 运行方式：node tests/suites/watcher-core.mjs（注册行归主控胶水，簇 T；run-all 暂不含本套）
 * 前置：node >= 20；无网络（全部 mock/内存对，唯一真实 IO=临时根文件）；总时长 <5s。
 *
 * 拆分说明（v1.3 巨型文件拆分，用户 2026-11-01 裁定）：本文件现为薄入口——断言实现体
 * 已按功能块搬入 ./watcher-core/ 子目录模块，本入口按原节序聚合执行（单一 try/catch
 * SUITE-FATAL 语义、BASE/T0/mkC11 生命周期、ck.summary() SUITE 输出契约全部保持）。
 * 功能块→模块映射（断言计数=222，与拆前一致）：
 *   shared.mjs           Checker 实例/小工具/零触网护栏（1 处全局副作用）
 *   mock-relay.mjs       MockTransport/MockRelay
 *   fixtures.mjs         板/coord 指针/mission/watcher 夹具+readSignals+createMkC11 工厂
 *   units.mjs            W-RED/W-POL/W-TXN/W-TTL/W-CRD（44）
 *   relay-bridge.mjs     W-RLY/W-BRG/W-REG/W-BRG2/W-WSA（38）
 *   inject-channel.mjs   W-INJ/W-INJ2/W-RESP（23）
 *   coord-session.mjs    C11/G4（10）
 *   trust-root.mjs       G5/G14/WA0/WB-RUN/W2（21）
 *   verdict-degrade.mjs  W-VRD+G11/W-DGR（18）
 *   transport-ws.mjs     W-TRN+W-DGR2/W-WS（21）
 *   e2e.mjs              W-E2E（24）
 *   wake-kick.mjs        W3-RIDER/WB-KICK/WB-SENT + unhandledRejection fail-loud 面（22）
 *   （入口本体 SUITE-FATAL 1）
 */
import { makeTempRoot } from "../harness/temp-root.mjs";
import { ck } from "./watcher-core/shared.mjs";
import { createMkC11 } from "./watcher-core/fixtures.mjs";
import { run as runUnits } from "./watcher-core/units.mjs";
import { run as runRelayBridge } from "./watcher-core/relay-bridge.mjs";
import { run as runInjectChannel } from "./watcher-core/inject-channel.mjs";
import { run as runCoordSession } from "./watcher-core/coord-session.mjs";
import { run as runTrustRoot } from "./watcher-core/trust-root.mjs";
import { run as runVerdictDegrade } from "./watcher-core/verdict-degrade.mjs";
import { run as runTransportWs } from "./watcher-core/transport-ws.mjs";
import { run as runE2E } from "./watcher-core/e2e.mjs";
import { run as runWakeKick } from "./watcher-core/wake-kick.mjs";

try {
  const BASE = makeTempRoot({ prefix: "orch-wcore-" });
  const T0 = Date.now();

  /* coord 指针根件（C11/G4/G5 守卫共用）：coord-session.txt 预置 + 计数写面 fsImpl。
     （拆分搬运：mkC11 实现在 fixtures.createMkC11，此处传入 BASE 工厂化实例化。） */
  const mkC11 = createMkC11(BASE);
  const ctx = { BASE, T0, mkC11 };

  await runUnits(ctx);
  await runRelayBridge(ctx);
  await runInjectChannel(ctx);
  await runCoordSession(ctx);
  await runTrustRoot(ctx);
  await runVerdictDegrade(ctx);
  await runTransportWs(ctx);
  await runE2E(ctx);
  await runWakeKick(ctx);

  void T0;
  BASE.cleanup();
} catch (err) {
  ck.ok("SUITE-FATAL（未捕获异常）", false, { msg: String((err && err.stack) || err).slice(0, 600) });
}

const { pass, fail } = ck.summary();
process.exit(fail ? 1 : 0);
