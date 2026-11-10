# patches/orch-meta-user - base snapshot description (Q-12 meta_user patch family)

- Family: `orch-meta-user` (notirc-w3 isomorphic: base snapshot + actions.json + patch spans manifest + verify legs)
- Wave: v1.7.0 W3a construction (mission m-20261109-093749-195d). Zero host install in this wave:
  this directory only registers the patch assets. Installation is a later wave behind the
  double gate (patcher QA passed + the user explicitly issuing `commands/orch-meta-user-patch.md`).

## Target base (the live host bundle)

| Face | Value |
|---|---|
| Target build | `zcode-cli-3.17.2.9661-win-x64-patched-2f753c85` (noti-rc base + n0-n4) |
| sha256 | `2f753c85685cd19afe802b5e6e46cc5a5f56b3f4fb2c338dc18cba5bdf5f22ba` |
| bytes | 15408529 |
| live path | `C:/Program Files/ZCode/resources/glm/zcode.cjs` |
| snapshot copy | `.zcode/orchestrator/patches/notirc-w3/zcode.cjs.n4` (sha256 verified byte-equal to the live bundle on 2026-11-09) |
| provenance | stock 3.17.2.9661 -> noti-rc n0-n3 (base `7781ec10`) -> n4 (patched `2f753c85`); all Q-12 anchors are pinned on the `2f753c85` state |
| drift rule | sha256(live) != the pin above -> anchors are stale -> re-pin flow (manifest.rollback.host_upgrade_repatch); the Q12-01 dry-run leg reports SKIP with the drift reason on non-matching hosts |

## Five-anchor map (proposal §3.1 A1-A5, DR-02 live re-verified 2026-11-09; line refs from the 3.17.2 base)

| Anchor family | Action(s) | Site (line region) | Byte action |
|---|---|---|---|
| A1 block construction | q12-m1 | L14359 region (Nxt/h3a meta_user block family) | insert sibling section builder `Yqb` (shape mirror of Nxt: name "Orch Memory", source `orch_meta_brief`, injectionTarget `meta_user`, cacheHint `dynamic`) |
| A2 collection filter | q12-m0 | L14376 (`injectionTarget==="meta_user"&&!A3a.has(a.source)`) | none - verify-only: A3a exclusion set = [env_info, model, current_date] does not contain `orch_meta_brief`, so the sibling section is auto-collected into metaUserAttachments (zero second-point patch) |
| A3 init single read | q12-m2 | L14687 region (init chain, right after the native `memoryIndexContent=await Hqa(...)` assignment) | replace: `await Xqb(this)` mirrors the native init-once read + carries `orchMetaBrief` into the init-time builder options |
| A4 per-request consumption | q12-m3, q12-m4 | L14655 region (qT build, both branches) | replace: builder option objects carry `orchMetaBrief:e.orchMetaBrief`; the main branch fires the mtime reread guard `Xqb(e)` (fire-and-forget - qT is synchronous and its return value is consumed by callers, so async surgery is forbidden) |
| A5 config carry | q12-m5, q12-m6 | L14687 region (F9o options->config copy) + L14379 region (build() Nxt call point) | replace: the config object copies `orchMetaBrief` through; build() pushes the sibling section via `Yqb(this.config.orchMetaBrief)` |
| R read strategy | q12-m7 | L14687 region (immediately before the native reader `Hqa` definition) | insert `Xqb` reader/guard: stat per call, `readTextFile` only on mtime-stamp change, `maxBytes:8192` fail-soft truncate, full try/catch (never rejects), gate = fileSystemPort+memoryRoot+workspaceRoot all present |

## Payload semantics

- Injection source: `<workspace root>/.zcode/orchestrator/context/meta-user-brief.md` (the plugin
  storage root's context/ directory; writer = the gleaning round, GL-20 family fourth view -
  see docs/protocols/card-memory-views.md §2a; cap target 8KB, first line `orch-meta-user: v1`).
- Read strategy: init-once read (q12-m2) + per-request mtime guard (q12-m4 fires Xqb; 1 async stat
  per request, re-read only on stamp change). The refreshed content lands for the next request
  (documented one-request lag); the current request always uses the cached value - fail-soft.
- Three fail-soft states of the reader (Q12-03): absent file -> no block (stat fails / kind!=file ->
  keep last known at refresh time); over-cap -> truncated at 8192 bytes via the port's maxBytes
  contract; mtime unchanged -> cached content reused, zero re-read.
- Injection gate: follows the native memory task-type gate - `memoryRoot` is only assigned for
  task types the native memory system serves, and the subagent builder path (aOn) never reaches the
  config carry. Subagents are unreachable by construction (pack purity; proposal §3.5 O-5 ruling).
- Data flow: session init reads the brief into `session.orchMetaBrief` -> builder creation options
  (init + qT both branches) -> F9o copies it into `builder.config.orchMetaBrief` -> build() wraps it
  as the sibling section (Yqb) -> the A2 filter collects it into `metaUserAttachments` per request.
- New identifiers (all verified absent on the base): `Xqb` (reader/guard), `Yqb` (section builder),
  `orchMetaBrief`, `orchMetaBriefStamp` (session fields), `orch_meta_brief` (section source),
  "Orch Memory" (section name). Payloads are pure function declarations - no top-level statements,
  no evaluation-order dependency (the native `Hqa` itself carries no r() registration; same shape).

## Registration evidence (dry-run on the pinned snapshot, 2026-11-09)

- Every anchor literal count == 1 on the `2f753c85` base (8/8), new-identifier pre-absence 8/8.
- Full apply -> 12 post-checks -> `node --check` pass (0.4s) -> patched sha256
  `a936cd0ef3c92449af7ea82a93c5e81461bef14a8a747eed51fceaf928ad1cdb` -> idempotent re-apply no-op ->
  reverse -> sha256 byte-exact restore to `2f753c85` -> anchor restoration + payload zero-residue.
- Measured spans live in actions.json (`span` per action) and manifest.json (`patch_spans`).

## Verify legs

- Q12-01 anchor-signature uniqueness (dry-run; live-bundle leg SKIP-tolerated on foreign hosts)
- Q12-02 apply -> reverse -> sha256 restore idempotency (+ `node --check` after apply)
- Q12-03 brief read-surface three-state fail-soft (reader unit legs + applied-fixture end-to-end legs)
- Q12-04 authorization command registration pin (commands/orch-meta-user-patch.md)
- Live probes (canary line / mtime reread / compression survival / rollback drill) are the
  post-authorization verification wave - registered in manifest.json, never in run-all.
