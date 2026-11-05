/*!
 * harness/source-family.mjs —— v1.3 切分重基（m-20261101-034720-a7a6 修复流 B）：静态锁族扫描面 helper
 *
 * 巨型文件拆分（server.mjs→薄入口+21 模块；bg-sentinel.mjs→薄入口+8 模块）后，按旧单文件
 * 扫描的静态锁失锚。本 helper 把扫描面重基为「入口+模块族」（主控裁决 EXTRA-2 口径）：
 *   - 族文件清单 readdir 动态取（不硬编码文件名单，后续新增模块自动纳入扫描面）；
 *   - 拼接序=入口在前、模块按文件名排序，单 "\n" 分隔；
 *   - 计数锁语义保持：族拼接 ≈ 拆分前原单文件（字节级搬移）+ import/export 接线行，
 *     锚计数与旧单文件口径一致（"恰一定义"在族面上仍为恰一；拆分若产生重复定义即红=真信号）。
 *
 * 族登记（FAMILIES）：键=入口相对路径；未登记 rel 按单文件读（非族面调用零感知，可全量换用）。
 */
import fs from "node:fs";
import path from "node:path";

const FAMILIES = {
  // server 族：薄入口 + mcp/ 同目录模块全集合（server-*.mjs ∪ tool-*.mjs，EXTRA-4 拆分布局 21 模块口径）
  "mcp/server.mjs": { modDir: "mcp", entryBase: "server.mjs" },
  // bg-sentinel 族：薄入口 + hooks/bg-sentinel/ 子目录模块全集合（core/signals/family/echo/wake-kick/fired/classify/glean-launch）
  "hooks/bg-sentinel.mjs": { modDir: "hooks/bg-sentinel", entryBase: "bg-sentinel.mjs" },
  // ---- v1.3 切分迭代 S1（m-20261101-070724-6958）：六套件族补登记（split-impl-design §2.0 逐字；
  //      modDir/entryBase 形状与既有两族同构，familyFiles 实现零改、套件族 rel 直接兼容；
  //      家族全景目标态 8 族=2 现状+6 套件，LM-06 FAM-REG 机械钉防静默收缩）----
  "tests/suites/crv8-memory.mjs": { modDir: "tests/suites/crv8-memory", entryBase: "crv8-memory.mjs" },
  "tests/suites/crv6-resilience.mjs": { modDir: "tests/suites/crv6-resilience", entryBase: "crv6-resilience.mjs" },
  "tests/suites/crv6-statemachine.mjs": { modDir: "tests/suites/crv6-statemachine", entryBase: "crv6-statemachine.mjs" },
  "tests/suites/crv2-pack.mjs": { modDir: "tests/suites/crv2-pack", entryBase: "crv2-pack.mjs" },
  "tests/suites/watcher-core.mjs": { modDir: "tests/suites/watcher-core", entryBase: "watcher-core.mjs" },
  "tests/suites/sentinel-teardown.mjs": { modDir: "tests/suites/sentinel-teardown", entryBase: "sentinel-teardown.mjs" },
  // ---- v1.5 W2-A T7 裁 a（m-20261102-223500-w15-2a）：tool-dispatch 族登记（条文 1「入口+同名子目录」，
  //      FAMILIES 8→9 族；21cba5 预案形态落地：组装纯区/模型播种/主流程三模块）----
  "mcp/tool-dispatch.mjs": { modDir: "mcp/tool-dispatch", entryBase: "tool-dispatch.mjs" },
};

/** mcp 族文件→层级（v1.3 切分实施设计 §2.2；新模块准入规则②：新文件必须登记一行） */
export const LAYER_OF = {
  "server.mjs": 4,
  "server-registry.mjs": 3,
  // L2（tool-*，10）
  "tool-board.mjs": 2, "tool-report.mjs": 2, "tool-mailbox.mjs": 2, "tool-spawn.mjs": 2,
  "tool-pack.mjs": 2, "tool-dispatch.mjs": 2, "tool-sandbox.mjs": 2, "tool-resume.mjs": 2,
  "tool-harvest.mjs": 2, "tool-probe.mjs": 2,
  // v1.5 W2-A tool-dispatch 二拆（准入规则②：新模块各登记一行；子目录族模块与入口同层 L2）
  // v1.6 W-p 剥离：dispatch-model.mjs 键随模块迁 parked/agent-orchestrator/ 删除（LM-06-DEP
  //   双向全等锁键面 25→24；同行分区编辑①）。
  // v1.6 W3a 组装退役：dispatch-prompt.mjs 键随文件退役删除（LM-06-DEP 双向全等锁键面
  //   24→23；同行分区编辑②——①②同行，W-p→W3a 强串行已隔离）；dispatch-core 键保留（R1
  //   残余下沉承载件）。
  "dispatch-core.mjs": 2,
  // L1（域服务，10）
  "server-boot.mjs": 1, "server-board.mjs": 1, "server-git.mjs": 1, "server-lessons.mjs": 1,
  "server-stores.mjs": 1, "server-sentinel.mjs": 1, "server-p2p.mjs": 1, "server-memory.mjs": 1,
  "server-manifest.mjs": 1,
  // v1.6 W-t 准入规则②（新文件必须登记一行；trajectory 写面域服务——裁定 A scope 增补件）
  "server-trajectory.mjs": 1,
  // L0
  "server-core.mjs": 0,
};
/** L2 横向边登记集（LM-06-DEP 规则②白名单；新增横向边=红） */
export const L2_HORIZONTAL_EDGES = [["tool-dispatch", "tool-harvest"]];

/** 族登记键归一：win32 path.join 产反斜杠，统一转正斜杠后查表（调用方两种写法等价）。 */
const familyKey = (rel) => String(rel).replace(/\\/g, "/");

/** 族文件绝对路径清单：入口在前 + 模块目录 *.mjs 按名排序（入口基名排除，防双计）。 */
export function familyFiles(pluginDir, rel) {
  const entryAbs = path.join(pluginDir, rel);
  const spec = FAMILIES[familyKey(rel)];
  if (!spec) return [entryAbs];
  const files = [entryAbs];
  try {
    const dir = path.join(pluginDir, spec.modDir);
    for (const f of fs.readdirSync(dir).sort()) {
      if (!f.endsWith(".mjs") || f === spec.entryBase) continue;
      const abs = path.join(dir, f);
      if (fs.statSync(abs).isFile()) files.push(abs);
    }
  } catch {
    /* 族目录缺失：返回入口单件，锚扫描面自然暴露红（锚随模块迁移时 entry 单读必失锚） */
  }
  return files;
}

/** 族源码拼接（lf=true 时 CRLF→LF 归一，供行锚正则；默认原样字节）。 */
export function familySource(pluginDir, rel, { lf = false } = {}) {
  const text = familyFiles(pluginDir, rel)
    .map((p) => fs.readFileSync(p, "utf8"))
    .join("\n");
  return lf ? text.replace(/\r\n/g, "\n") : text;
}
