# harness/accelerate.md —— 加速参数表（时间类断言的换算规则）

覆盖断言组：A-v031-S 组、A-v041-V 组（哨兵 live，L2 抽样/发版门）、A-v020-A06（Stop 判定窗）。
运行方式：文档型 harness，无独立入口——哨兵/hook 时间类用例按本表取参组装 CLI 参数（配 harness/capture.mjs 的后台捕获壳）。
哨兵/hook 时间用例禁真实等待——用 CLI 加速参数把分钟级窗口压到秒级；本文件是参数的单一事实源。

## v0.3 组（单实例哨兵，A-v031-S03 等考古用例）

```
--poll-sec 1 --wake-timeout-min 0.05 --wake-retries 2
```

效果：超时→重试→放弃全链约 6–9 秒 exit 1。

## v0.4.1 组（哨兵 v2 家族槽位制，现行）

```
--poll-sec 1 --wake-grace-min 0.05 --refire-gap-min 0.5 --family-size 3
```

常用补充：`--max-lifetime-min 0.05`（最大寿命速测，V15/S06）；`toast_on_abandon:false`（V17 静音）。

## 换算规则

- 断言中的"分钟刻度"按 `实际秒 ≈ 分钟数 × 参数比例` 换算；例：wake-grace-min 0.05 = 3 秒。
- 分级首枪（V4）：blocked 刻度(3min) 必须先于 done 刻度(5min)——加速后按同比例先后仍成立。
- cap_window=120min 为硬窗（V5/V6），不提供加速参数；如需验证用 cfg 桥（V12）改写推导值。
- 双实例竞争（V9）断言"日志恰 1 条/窗"依赖 refire-gap-min 拉长窗口。

## 前置与红线

- 哨兵 live 用例需真实 `hooks/bg-sentinel.mjs` 进程 + 临时根 + `--root`/cfg 桥指向；用 captureBackground 捕获。
- 时间断言只断言先后序与 exit code，不断言精确墙钟值（平台调度抖动）。
- 服务端写出的 `sentinel.cfg.json`（V12）与 CLI 冲突时 CLI 覆盖——断言"CLI 覆盖 cfg"时利用此序。
