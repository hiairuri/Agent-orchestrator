# The memory-view contract: derived views of the lessons store (the digest / the dual ORCH.md views [project@project root + fleet@fleet root, pull-only] / the meta-user brief [fourth view, writer-side])

- **Home modules**: mcp/server-memory.mjs (the digest read-validate face + the dual ORCH.md ver-header parsing / cap-cfg consumption face + the gate/signal/glean-pack faces) + mcp/server-boot.mjs (`ORCH_MD_FILE` project-root view path + `FLEET_ORCH_MD_FILE` fleet-root view path) + the server-materialized glean-pack (the digest duty + view-domain + fourth-view baking rules); the views are all **derived views** of the lessons store (memory/lessons.jsonl) - their sync mechanisms and invalidity semantics are projections of one contract face, hence one card; the sole writer of the views is the gleaning round (GL-20a fleet / GL-20b project - the rules are dual-carried by the server-baked glean-pack RULES and this card; the orchestrator persona file is retired)
- **Brittleness rating** (surface-breadth x consequence-severity dual axis): **medium** - all views are read-only projections (the lessons event rows are the source); a broken view does not break the source; but the views' invalidity semantics are asymmetric (the digest has the five-level chain; the ORCH.md views are pull-only with no freshness face; the meta-user brief is mtime+ver self-describing) - §4 declares them
- **Anchor declaration**: all line numbers in this card were measured at assembly time; **line numbers are not referenced across versions** (l-20261022-6a14d6); function/constant-name dual anchors are the locating authority

---

## 0. The common face (the contract shared by the views)

| Face | Content |
|---|---|
| Source | `<memoryRoot>/memory/lessons.jsonl` (fleet store) + per-project `<storage root>/memory/lessons.jsonl` (event-row append-semantics source) - **lessons event rows are never written directly**, all adds/changes go through the lessons tool (the view-layer boundary rule) |
| Writer | The sole writer = the gleaning round (GL-20a fleet view / GL-20b project view / GL-20 family fourth view; server-materialized fixed pack glean3 + brief authoritative pointers); the server is **read-only** on every view (the ORCH.md views are pure read faces - the v1.6 W2 ver-sync piggyback surfacings are retired; the v1.7.0 W1 dual-view ruling puts the project view at the project root and the fleet view at the fleet root) |
| Domain split (GL-20a/20b) | Per candidate/rewrite: content that still holds generally after the project's proper names are stripped = fleet view (user preferences, coordinator discipline, cross-project lessons); content that only holds in this project's context (progress/paths/versions/project craft) = project view; the standing promotion standard (cross-project recurrence >= 2 or score>=0.7 AND hits>=3 AND age>=7d) is the regular project-view -> fleet-view promotion channel; dual-domain hits land the conservative side (project view) and list in the report OPEN section; write order: read brief.views -> project view ver+1 -> fleet view ver+1 -> digest -> report |
| Authoritative pointers | Paths always come from brief fields (brief.digest.path/sidecar_path, brief.lock_path) - "authoritative pointer, never hand-write it" (template incident ① root cure) |
| brief views block | **brief five-key read-only view snapshot** (v1.7.0 W1 dual-view form, O-3 direct re-key): `{orch_md_exists, orch_md_ver, fleet_orch_md_exists, fleet_orch_md_ver, global_lib_lines}` - `orch_md_*` = the project view (project-root ORCH.md; existence = the project memory feature switch, GL-21's new carrier), `fleet_orch_md_*` = the fleet view (fleet-root ORCH.md; missing = first-creation duty), `global_lib_lines` = fleet-store non-empty line count; re-materialized at every gate-due (invalidity = materialization-time snapshot, no independent face; read-only, zero write); retired keys: `global_agents_md_exists` (renamed) and `agents_md_marker_exists` (marker mechanism retired, §3); the action legs are dual-carried in the same wave by GL-20a/20b and the glean-pack baked RULES (fleet missing or fleet memory/ directory missing = create first, first write only with content, never an empty shell; project view missing = skip + report, never rebuild), the server-side fallback mkdir only creates the `<memoryRoot>/memory/` directory, never shell files (a shell file's mtime enters the digest fingerprint = a false signal) |
| Gleaning gate | The glean_due signal (gate: idle_hours/new_events/busy_channel_events three measured keys [the v1.3 busy leg: time gate fails AND new entries >= busy_channel_events backstop, 0 = off]; glean.cfg.json adjustable, junk falls back) - surfaces via board list; the coordinator decides whether to launch the gleaning round (the server cannot spawn) |
| M7-1 tail-addendum landing | The M6 option-B archaeology (lessons.jsonl update form) conclusion landed in this card §6 - option B closed out |

## 1. View one: digest (md + json sidecar)

| Face | Content | Anchor |
|---|---|---|
| Physical form | `<memoryRoot>/digest/<rootId>/pack-tail-digest.md`: first line `generated_at: <ISO8601>` + body <=12 lines/<=1200B (DIGEST_MAX_LINES/BYTES, rootId-keyed isolation); sidecar `pack-tail-digest.json`: `{generated_at, rootId, sources:{lessons_lines, lessons_mtime_ms, orch_md_mtime_ms, journal_tail_seq}, bytes}` - **v1.7.0 W1 fingerprint source switch: `agents_md_mtime_ms` -> `orch_md_mtime_ms`** (the project-root view file's mtime replaces the retired memory-root AGENTS.md's; sidecars recorded before the switch carry the old key = conditional-participation miss, judged stale once then refreshed by the next round) | mcp/server-memory.mjs digestSourcesNow/digestMdFile/digestJsonFile; GL-32 |
| Writer | The gleaning round overwrites both files atomically per round (no digest history kept); body = situation face (one sentence of project state + in-flight mission summary) + time face (3-5 recent rulings/key events); task-related search content forbidden | glean-pack RULES digest duty (server-baked); GL-32/33 |
| Reader (remaining) | board/list `glean_due.digest` freshness subkey (tool-board read-only) + the gleaner brief.digest path materialization (dormant keep face) - the v1.6 W3a pack-face renderer pipeline (buildDigestSection/dispatchDigestRead) is retired; read failures never block | mcp/server-memory.mjs readProjectDigest + its retirement comment |

**Five-level chain** (`readProjectDigest`, fail-safe contract): judge the body, not all lines (QA P2-a) -

1. file missing -> `missing` (readers fall back, no STALE noise);
2. first line missing `generated_at` -> stale;
3. body over cap (>12 lines/1200B) -> stale;
4. body empty -> stale;
5. sidecar missing/unparsable -> stale; fingerprint comparison **ordered short-circuit**: `lessons_lines` mismatch -> `lessons_mtime_ms` -> `orch_md_mtime_ms` (conditional participation: compared only when the sidecar recorded it; rootId mismatch = treated as missing).

**stale != blocking**: a stale body still renders with an explicit `STALE: <stale_reason>` injection head (graded copy per drift, M8-1 N5 absolute: <=5 minor / >5 significant); assembly never fails because a view is old; missing is what falls back. **Zero auto-recovery after STALE**: the only refresh path = the next gleaning round; any lessons append between rounds keeps the digest permanently STALE (graded rendering carries the "worth trusting?" judgment).

## 2. View two+three: the dual ORCH.md views (coordinator memory, pull-only)

> **Teardown/retirement notes**: (1) v1.6 W2 (directive ①): the piggyback three-surfacing push (top-level `orch_memory.orch_md` attachment + content-plane `orch_md` key + bytes/mtimeMs baseline) retired in full - `orchMdAttachment` removed, orch_md never present on any tool result; anti-regrowth = the N9 negative pin (crv8-memory sync scenario 6, dual-view since v1.7.0). (2) v1.7.0 W1 (Q1 fleet-root ruling): the single `<storage root>/ORCH.md` view split into the dual views - the project view moved to the project root (ORCH_MD_FILE = `<project root>/ORCH.md`), the fleet view newly landed at the fleet root (FLEET_ORCH_MD_FILE = `<fleet root>/ORCH.md`; the retired fleet-wide AGENTS.md merged into it).

| Face | Project view | Fleet view |
|---|---|---|
| Physical form | `<project root>/ORCH.md` (ORCH_MD_FILE); header `<!-- orch-memory ver=<N> updated=<ISO8601> -->` (missing/unparsable header reads ver 0) | `<fleet root>/ORCH.md` (FLEET_ORCH_MD_FILE = `<~/.zcode>/orchestrator-memory/ORCH.md`, `--memory-root` overrides); same ver header form |
| Writer | Gleaning round GL-20b: ver+1 full-file atomic rewrite per round | Gleaning round GL-20a: ver+1 full-file atomic rewrite per round; the two ver counters are independent |
| Cap | cfg opt-in: `glean.cfg.json` keys `orch_md_max_lines` [default 120] / `orch_md_max_bytes` [default 10240], per-key junk fallback, defaults = ORCH_MD_MAX_LINES/_BYTES constants (identifiers retained, lint-manifest pin); consumption = the gleaning write cap (the fixed-pack RULES cap sentence renders from cfg, SYNC-20/21) + GL-20b reads brief.cfg | cfg keys `fleet_orch_md_max_lines` [default 50] / `fleet_orch_md_max_bytes` [default 2KB] (v1.7.0 W1 new, defaults = the GLOBAL_MEM_* constant family), same per-key fallback; consumption = the RULES dual-cap sentence + GL-20a |
| Feature switch | **Existence = the project memory feature switch (GL-21's new carrier)**: missing = feature off for that project - gleaning skips + reports + never rebuilds (no empty shell); re-enabling = the file exists again | Missing = first-creation duty (create first, mkdir -p, first write only with content, never an empty shell; first-creation events listed in a dedicated report section) |
| Read face | **No push (pull-only)**: the coordinator loads via the /manual four-file blocking read (2b = this view) + reconciles via `probe file.head` as needed; the subagent face never receives either view (worker memory rides the task pack CONTEXT channel) | Same pull-only law; /manual read (2a) + `probe file.head`; also the pack GLOBAL MEMORY conditional section source (§5) |
| ver consumption | ver/updated_at parsed only into the glean-brief snapshot (brief.orch_md.ver + brief.views.orch_md_*) - the consumer treats the brief fields as the authoritative snapshot | Same, into brief.views.fleet_orch_md_* |
| Content domains | Project progress (in-flight), project facts (environment/paths/release baselines), project-domain active lessons, the fleet-view pointer line + latest report pointer | Standing user preferences, coordinator-level lessons (cross-project recurrence >= 2 as the main body), per-project view pointer lines (path + ver, one line per project), gleaning report/digest pointers |

**Invalidity semantics (pull-only)**: what the consumer reads is the state at read time - no baseline, no replay, no removed notice; staleness risk is carried by consumption discipline (OV-9 dual-view probe reconciliation + the brief.views snapshots refreshed at gate-due). The probe seam (mutual pointers, never merged): probe (`card-probe.md`) only guarantees "what is read is the file's actual bytes" (caps/cache/envelope live on that card and `cache-policy.md`); view semantics (freshness/STALE/snapshot authority) live on this card.

## 2a. View four: the meta-user brief (writer-side contract; the read face is the W3 patcher scope)

| Face | Content |
|---|---|
| Physical form | `<storage root>/context/meta-user-brief.md` (the project storage root's context/ directory); first line `orch-meta-user: v1` marker (increment v per rewrite; the mtime+ver pair = the invalidity face) |
| Writer | The gleaning round (GL-20 family member): rewrites it in full each round; cap target 8KB; body = curated summary: fleet view digest + project view digest + goal-stack line + sentinel/in-flight one-line status; first write only with content, never an empty shell |
| Rule carrier | The glean-pack baked RULES fourth-view sentence (server-baked) + this section - dual-carried in the same wave |
| Not a platform memory file | This is a plugin-owned file (orchestrator runtime face), never enters the host native `memories/projects/<hash>/` governance directory (RULE red line) |

## 3. Retired view: the AGENTS.md orch-mem marker block (v1.7.0 W1 tombstone)

The project-root AGENTS.md orch-mem marker pair (`<!-- orch-mem:begin v1 ... -->` / `<!-- orch-mem:end -->`) and its section mechanism are **retired** with the dual-view wave: the feature-switch semantics migrated to the project view's existence switch (§2, GL-21 form change - missing file = feature off, skip + report + never rebuild); the fleet-wide AGENTS.md is likewise retired (its global section content merged into the fleet ORCH.md, §5). The root AGENTS.md returns to the pure subagent-craft + project-identity face (the memory section moves out at the W2 migration M5). Anti-regrowth = zero-marker negative pins (typed-dispatch-docs A-V080-DOC-02 rewrite + the Q10-10 AGENTS.md zero-marker leg); colon variants of the old register never existed and stay unrecognized.

## 4. The failure-semantics master table

| Case | digest (§1) | Project view (§2) | Fleet view (§2) | Meta-user brief (§2a) |
|---|---|---|---|---|
| Content stale (source moved, view not updated) | Five-level chain -> STALE tag still renders (never blocks); recovery = next round; grading per M8-1 | No push, no freshness face - consumption discipline carries it (OV-9 probe reconciliation + brief snapshot refreshed at gate-due) | Same project-view law | mtime+ver pair is the invalidity face - the per-request consumer re-reads on mtime change (the read face itself is the W3 patcher scope; the writer contract lives here) |
| View file missing | missing -> readers fall back | **Feature-off semantics (not a missing-file fault)**: gleaning skips, never rebuilds (GL-21); manual reads fail soft ("empty memory, continue") | First-creation duty: gleaning creates it first (content only, never an empty shell; first-creation events reported) | Missing = written fresh that round (content only, never an empty shell) |
| View corrupted/half-written | Chain degrades level by level (cap clamps rendering) | The next gleaning round's full-file overwrite absorbs the drift; manual edits are user input - the next round may integrate or overwrite (provenance recorded in the report) | Same law (GL-20a writer monopoly) | Same law (GL-20 family writer monopoly) |
| Multi-writer races | Single writer (gleaning) + atomic overwrite | Single writer (GL-20b); server read-only | Single writer (GL-20a); server read-only; the pack GLOBAL MEMORY section reads are server-side pure reads | Single writer (GL-20 family); the per-request reader is read-only |
| Over cap | Body clamp (G4: 12 lines/1200B) | No server-side truncation - the cap = the gleaning rewrite face (GL-20b reads brief.cfg; the RULES cap sentence renders from cfg, SYNC-20/21); coordinator-side blast radius carried by the /manual "within caps" read semantics | Same law (GL-20a; fleet cap 50/2KB defaults) | Cap target 8KB, writer-side self-discipline + report counts (no mechanical enforcement - the asymmetry point, extend this row first when expanding) |

## 5. The pack GLOBAL MEMORY consumption face (fleet view reader)

- The conditional GLOBAL MEMORY pack section (tool-pack; `pack_global_section` cfg switch, default false = opt-in) reads **the fleet ORCH.md** since v1.7.0 W1 (the retired fleet AGENTS.md source; the section head literal is unchanged - the po-static pin carries it); cap 50 lines/2KB (GLOBAL_MEM_* constants) with the truncation hint carrying the fleet view path.
- Domain logic: the fleet view is exactly the cross-project half of the memory world; the project half reaches packs via the task pack CONTEXT channel (PC-5), never via this section.

## 6. Tail addendum (the M7-1 archaeology conclusion - landed)

**Question**: is the lessons.jsonl update form append-only IO or a whole-file rewrite? (pre-archaeology for the fingerprint-granularity option B.)

**Conclusion 1: the update form = whole-file read-merge-rewrite, not IO append.** Sole write outlet = `saveLessons` (whole-list JSON serialize join -> atomicWriteFileSync); zero `appendFileSync` in the stores; all write paths run load -> mutate -> saveLessons inside the root lock; "append-only, never reordered" is list semantics (tail appends, in-place status flips), not IO append semantics.

**Conclusion 2: the two-factor fingerprint (lessons_lines + lessons_mtime_ms) has no blind spot under this write form; option B is closed out, not initiated.** Structural changes move line count + mtime; in-place changes keep line count but necessarily touch mtime (a whole-file rewrite always does) - no third class exists; the ordered short-circuit (lines first, mtime conditional) is sorted "structural first, in-place second", self-consistent. The v1.7.0 fingerprint source switch (§1) changes the conditional third member's source file, not this ordering; finer granularity stays uneconomical (STALE graded rendering carries the presentation-layer demand).

**Ruling record**: option B = "closed out (the archaeology negated its premise)"; this section is the sole authoritative carrier of that conclusion. Future write-form evolution must first change the saveLessons outlet and rewrite this section, reopening the archaeology - skipping this section and touching the fingerprint directly is forbidden.

## 7. Assertion anchors

- **crv8-memory/glean-gate**: the GLEAN-04d views five-key family (dual-view snapshot legs) + the G13 fixed-pack template pins (dual-cap/dual-switch view-layer boundary sentence, fourth-view sentence, domain-split sentence).
- **crv8-memory/sync**: the N9 dual-view negative pin (no orch_memory top-level key ∧ no orch_md content key across both views' lifecycles) + SYNC-20/21 cap-sentence rendering (project view).
- **po-static**: the GLOBAL MEMORY section head + data-fence literals; the C1-02/C1-06 + A-v0163-TR manual four-file family; the Q06 goal-term family (OV-10/PL-11/glossary/goal stack) + the Q10 def-shape pins (ORCH_MD_FILE/FLEET_ORCH_MD_FILE).
- **typed-dispatch-docs**: the A-V080-DOC-01 absence negative (orch-gleaner persona stays deleted) + the A-V080-DOC-02 zero-marker rewrite + the Q10-10 AGENTS.md zero-marker negative.
- **LM-05** (lint-manifest): this card's constant/function names grep-visible - mcp/server-memory.mjs: readProjectDigest/digestSourcesNow/parseOrchMdHeader/DIGEST_MAX_LINES/ORCH_MD_MAX_LINES/digestGradedStaleReason/DIGEST_DRIFT_N; mcp/server-boot.mjs: ORCH_MD_FILE/FLEET_ORCH_MD_FILE; the card exists and is non-empty.

## 8. Maintenance rules

- Evolution of any view's chain/caps/keys: this card's corresponding section + the crv8/po-static assertions + the server-baked glean-pack RULES, three places in the same wave - the baked RULES and this card are the dual-source execution face of one contract (the retired persona file no longer carries rules; do not replant it - the absence negatives pin that).
- View addition/removal: answer three questions first (who is the writer / where do the invalidity classes land / does it enter the glean-pack baked RULES) before touching this card - a view without declared invalidity semantics must not go live (the fourth view registered per this rule at §2a).
- Ver-header format evolution: increment the register version + sync GL-20a/20b + declare the compatibility window in this card; the read law (missing/unparsable header = ver 0) does not change with versions.
