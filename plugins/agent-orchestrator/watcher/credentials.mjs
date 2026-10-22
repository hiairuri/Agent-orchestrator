/*!
 * watcher/credentials.mjs —— CREDS 凭证管理（W-G S0-S3 链全收编）
 *
 * 职责（W-W §5 + W-G §4/§5 修订）：
 *   - S0 定位 ~/.zcode/v2/credentials.json（只读；缺失 → D1）
 *   - S1 内存解密 zcodejwttoken（enc:v1 AES-256-GCM，sha256 fallback 推导；JWT 零落盘零缓存，
 *     进程内存生存期=单事务——W-G §4 回写点 (1)）
 *   - S2 设备发现（GET /api/v1/remote/device，schema OC；备选 setting.json 交叉）
 *   - S3 签发 POST /api/v1/remote/token {role:"terminal"}（EXP-1 已证：expires_in=60s；
 *     safeParse 严格正则 ^[A-Za-z0-9_-]{21}[AQgw]$；未知形态安全失败即 D1，W-G §5.6）
 *   - REDACTED 日志闸：redact() 对 22 字符 base64url token 形态与 Bearer 头归零
 *     （W-G §5.4 宿主同款纪律；对账锚点=「grep token 正则形态归零」自检，watcher-core 覆盖）
 *
 * 失效语义（W-G §2）：签发 401 ⇔ 用户登出/token_version 吊销 → 终态 D1，不做重试轰炸；
 * JWT claims 无 exp 属预期（token_version 机制），绝不按 exp 误判过期。
 *
 * 零持久化纪律：本模块对 credentials.json/setting.json 仅读，永不写；解密只发生内存，
 * 无中间文件；测试只注入 mock 文本，零真实凭据触达。
 * 零 npm 依赖；node >= 20（global fetch）。
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const TOKEN_RE = /^[A-Za-z0-9_-]{21}[AQgw]$/; // W-F3 gps / W-G §1.3 schema
export const CREDENTIALS_PATH = () => path.join(os.homedir(), ".zcode", "v2", "credentials.json");
export const SETTING_PATH = () => path.join(os.homedir(), ".zcode", "v2", "setting.json");

/* --- 密钥推导与 AES-256-GCM 解密（W-G §1.1 全案） --- */

/** sha256(ZCODE_CREDENTIAL_SECRET ?? "zcode-credential-fallback:<platform>:<homedir>:<username>")。 */
export function deriveCredentialSecret({ env = process.env, platform = process.platform, homedir = os.homedir(), username = os.userInfo().username } = {}) {
  const secret = env.ZCODE_CREDENTIAL_SECRET || `zcode-credential-fallback:${platform}:${homedir}:${username}`;
  return crypto.createHash("sha256").update(secret, "utf8").digest();
}

/** enc:v1:<b64url iv12>.<b64url tag16>.<b64url ct> → 明文 utf8；任何失败 → null（安全失败）。 */
export function decryptEntry(encString, key = deriveCredentialSecret()) {
  try {
    if (typeof encString !== "string" || !encString.startsWith("enc:v1:")) return null;
    const parts = encString.slice("enc:v1:".length).split(".");
    if (parts.length !== 3) return null;
    const iv = Buffer.from(parts[0], "base64url");
    const tag = Buffer.from(parts[1], "base64url");
    const ct = Buffer.from(parts[2], "base64url");
    if (iv.length !== 12 || tag.length !== 16) return null;
    const d = crypto.createDecipheriv("aes-256-gcm", key, iv);
    d.setAuthTag(tag);
    return Buffer.concat([d.update(ct), d.final()]).toString("utf8");
  } catch {
    return null; // tag 校验不过=损坏或密钥环境已变 → 只读不动、不自我修复（W-G §4）
  }
}

export function encryptEntry(plain, key = deriveCredentialSecret()) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([c.update(Buffer.from(plain, "utf8")), c.final()]);
  return `enc:v1:${iv.toString("base64url")}.${c.getAuthTag().toString("base64url")}.${ct.toString("base64url")}`;
}

/* --- JWT 形态自检（W-G S1：3 段+可打印 ASCII；token_version 在则记，无 exp 不判过期） --- */

export function inspectJwt(jwt) {
  if (typeof jwt !== "string") return { ok: false, reason: "not-string" };
  const v = jwt.trim();
  if (!v || v.length > 4096) return { ok: false, reason: "bad-length" };
  if (!/^[\x20-\x7e]+$/.test(v)) return { ok: false, reason: "non-printable" };
  const segs = v.split(".");
  if (segs.length !== 3) return { ok: false, reason: "not-3-segments" };
  let claims = null;
  try {
    const json = JSON.parse(Buffer.from(segs[1], "base64url").toString("utf8"));
    if (json && typeof json === "object") claims = { tokenVersion: json.token_version != null, hasExp: json.exp != null, userId: json.user_id != null };
  } catch { /* claims 不可解析不致命（形态自检以段与可打印为准） */ }
  return { ok: true, claims };
}

/**
 * S0+S1：读凭据库 → active_provider 闸（zai|bigmodel）→ 解密 zcodejwttoken。
 * 返回 {ok:true, jwt} 或 {ok:false, reason}（reason 全部映射 D1；绝不抛真实值）。
 */
export function loadPlatformJwt({ credPath = CREDENTIALS_PATH(), key, provider, fsImpl = fs } = {}) {
  let raw;
  try {
    raw = fsImpl.readFileSync(credPath, "utf8");
  } catch {
    return { ok: false, reason: "credentials-missing" };
  }
  let entries;
  try {
    entries = JSON.parse(raw);
    if (!entries || typeof entries !== "object" || Array.isArray(entries)) return { ok: false, reason: "credentials-corrupt" };
  } catch {
    return { ok: false, reason: "credentials-corrupt" };
  }
  const active = provider || decryptEntry(entries["oauth:active_provider"], key) || entries["oauth:active_provider"];
  if (active != null && !["zai", "bigmodel"].includes(String(active))) return { ok: false, reason: "provider-unsupported" };
  const enc = entries["zcodejwttoken"];
  if (typeof enc !== "string" || !enc) return { ok: false, reason: "jwt-absent" };
  const jwt = decryptEntry(enc, key);
  if (jwt == null) return { ok: false, reason: "decrypt-failed" };
  const shape = inspectJwt(jwt);
  if (!shape.ok) return { ok: false, reason: "jwt-shape:" + shape.reason };
  return { ok: true, jwt, claims: shape.claims };
}

/** S2 备选：setting.json webRemoteControlRelayV2Device.deviceSid（本地零网络）。 */
export function loadLocalDevice({ settingPath = SETTING_PATH(), fsImpl = fs } = {}) {
  try {
    const s = JSON.parse(fsImpl.readFileSync(settingPath, "utf8"));
    const d = s && s.webRemoteControlRelayV2Device;
    return d && d.deviceSid ? { deviceSid: String(d.deviceSid), deviceMid: d.deviceMid != null ? String(d.deviceMid) : null, endpointOrigin: d.endpointOrigin ? String(d.endpointOrigin) : null } : null;
  } catch {
    return null;
  }
}

/* --- HTTP 面（fetchImpl 可注入；15s timeout / redirect:error / Bearer——宿主同参，W-G §1.3） --- */

async function httpCall(fetchImpl, url, { jwt, method = "GET", body, timeoutMs = 15000 }) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, {
      method,
      headers: { Authorization: `Bearer ${jwt}`, "Content-Type": "application/json" },
      body: body == null ? undefined : JSON.stringify(body),
      signal: ctl.signal,
      redirect: "error",
    });
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = null; }
    return { status: res.status, json };
  } catch (err) {
    return { status: 0, error: err && (err.name === "AbortError" ? "timeout" : "network") };
  } finally {
    clearTimeout(timer);
  }
}

/** S2：GET /api/v1/remote/device → 设备行数组（schema OC 形态校验；未知形态安全失败）。 */
export async function fetchDevices({ fetchImpl = fetch, origin, jwt, timeoutMs = 15000 }) {
  const r = await httpCall(fetchImpl, `${origin}/api/v1/remote/device`, { jwt, timeoutMs });
  if (r.status === 401) return { ok: false, kind: "auth-required" };
  if (r.status === 0) return { ok: false, kind: r.error };
  if (r.status < 200 || r.status >= 300) return { ok: false, kind: "relay-unavailable" };
  const list = r.json && (r.json.data ?? r.json);
  if (!Array.isArray(list)) return { ok: false, kind: "safe-parse" };
  const devices = list.filter((d) => d && typeof d.device_sid === "string" && typeof d.device_mid === "string");
  if (!list.length || devices.length !== list.length) return { ok: false, kind: "safe-parse" };
  return { ok: true, devices: devices.map((d) => ({ deviceSid: d.device_sid, deviceMid: d.device_mid, online: d.online === true, meta: d.meta || {} })) };
}

/** S2 拣选：在线优先；localSetting 交叉一致者优先；均无在线 → ok:false（D2/D3 面）。 */
export function pickDesktopDevice(devices, localSetting = null) {
  const scored = devices.map((d) => ({
    d,
    score: (d.online ? 2 : 0) + (localSetting && localSetting.deviceSid === d.deviceSid ? 1 : 0),
  }));
  scored.sort((a, b) => b.score - a.score);
  const best = scored[0] && scored[0].score > 0 ? scored[0].d : null;
  return best ? { ok: true, ...best } : { ok: false, kind: "no-device" };
}

/**
 * S3：POST /api/v1/remote/token {role:"terminal"}。EXP-1 定案 expires_in=60。
 * 分类返回：{ok, token, expiresInSec} | {ok:false, kind:"auth-required"|"relay-unavailable"|"timeout"|"network"|"safe-parse"|"code"}
 */
export async function issueTerminalToken({ fetchImpl = fetch, origin, jwt, role = "terminal", timeoutMs = 15000 }) {
  const r = await httpCall(fetchImpl, `${origin}/api/v1/remote/token`, { jwt, method: "POST", body: { role }, timeoutMs });
  if (r.status === 401) return { ok: false, kind: "auth-required" }; // token_version 吊销 → D1 终态
  if (r.status === 0) return { ok: false, kind: r.error };
  if (r.status < 200 || r.status >= 300) return { ok: false, kind: "relay-unavailable" };
  const data = r.json && typeof r.json === "object" ? r.json.data : null;
  const code = r.json && typeof r.json === "object" ? r.json.code : null;
  if (code !== 0) return { ok: false, kind: "code" }; // W-G 失效树：code≠0 auth 语义 → D1
  const token = data && typeof data.token === "string" ? data.token : null;
  const expiresInSec = data && Number.isInteger(data.expires_in) && data.expires_in > 0 ? data.expires_in : null;
  if (!token || !TOKEN_RE.test(token) || expiresInSec == null) return { ok: false, kind: "safe-parse" }; // W-G §5.6
  return { ok: true, token, expiresInSec };
}

/* --- REDACTED 日志闸（本文件纪律的运行时化；watcher 全部出口经此） --- */

const TOKEN_SHAPE_RE = /\b[A-Za-z0-9_-]{21}[AQgw]\b/g;
const BEARER_RE = /(Bearer\s+)[^\s"']+/gi;

/** token 正则形态与 Bearer 头归零；idempotent；无密文也可安全调用。 */
export function redact(text) {
  let s = String(text ?? "");
  s = s.replace(TOKEN_SHAPE_RE, "REDACTED");
  s = s.replace(BEARER_RE, "$1REDACTED");
  return s;
}

/** 「grep 22 字符 base64url 形态归零」自检（W-W §5.5 对账锚点）。 */
export function redactionSelfCheck(text) {
  const s = String(text ?? "");
  return !TOKEN_SHAPE_RE.test(s) && !/Bearer\s+(?!REDACTED\b)\S/i.test(s);
}
