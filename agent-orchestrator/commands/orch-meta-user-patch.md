---
name: orch-meta-user-patch
description: "Authorization gate + install/rollback flow for the orch-meta-user host patch (meta_user per-request curated memory brief)"
---

Authorization gate for the Q-12 meta_user patch family (source assets:
`patches/orch-meta-user/`). Issuing this command IS the explicit user authorization for
installing that host patch. The double gate still applies in full: the patcher QA
(Q12-01..04 legs) must already have passed, and installation touches the live host
bundle - never patch in place, every byte runs through a temp copy first.

## Absolute anchors (resolved from the ZCode config at run time)

All directories in this command are resolved from the ZCode configuration at run time -
nothing is hard-coded to a machine or a drive. Workspace-independent: directories come
from config resolution, so this command works in any workspace with zero cwd dependence.

1. Plugin directory (preferred): read `installed_plugins.json` under the ZCode CLI config
   root (`<cli-root>/plugins/installed_plugins.json`; `<cli-root>` is the per-user CLI
   state root, typically under the home directory). Find the `agent-orchestrator` entry
   and take its `installPath` - the active installed plugin directory, laid out as
   `<cli-root>/plugins/cache/<marketplace-hash>/<plugin-name>/<active-version>/`.
2. Plugin directory (fallback): read `<cli-root>/plugins/known_marketplaces.json`, find
   the marketplace that provides this plugin, resolve that marketplace's registered local
   source root, and use `<marketplace-root>/<plugin-name>/`.
3. Asset root: `<plugin-directory>/patches/orch-meta-user/` - every asset this flow
   touches lives under it: `actions.json`, `manifest.json`, `base-snapshot.md`, and the
   patch json bundle. Address all reads through this resolved root.
4. Live bundle: resolve the active host CLI bundle from the ZCode CLI installation
   configuration (the CLI program path of the running install) - never inline it in this
   command. The base identity pin (target build + sha256) is always read from
   `manifest.json` (`base.target_build` / `base.sha256`); the `base.live_path` field
   records the resolving machine's current value as data only, not as an anchor.

Install pipeline in one line: dry-run anchor verification (zero network) -> apply to a
temp copy -> `node --check` -> verify-before-install post-checks -> sha256 cross-check ->
register the installed record + rollback anchor in the runtime manifest; live
session-level verification is section 3, a separate step.

## 0. Preconditions (all must hold; abort with a report otherwise)

1. Base identity: sha256 of the live bundle - resolved from the ZCode CLI installation
   configuration (standard install shape: `<cli-root>/resources/glm/zcode.cjs`) -
   equals the pin in `patches/orch-meta-user/manifest.json` (`base.sha256`).
   Mismatch = stale anchors = run the re-pin flow (section 5) instead, then come back
   for a fresh authorization.
2. Verify legs green: `node tests/run-all.mjs --ids patcher-q12` passes all four legs.
3. Brief writer in place: the gleaning round's fourth-view RULES are live (server side)
   so the brief at `<storage root>/context/meta-user-brief.md` exists or will be created
   by the next gleaning round (first write only with content, never an empty shell).

## 1. Show the patch list (before any byte change; present to the user)

Summarize from `patches/orch-meta-user/`: `base-snapshot.md` (target sha256 + provenance),
`actions.json` (8 actions q12-m0..m7 with anchor families, measured spans, verify arrays),
`manifest.json` (patch_spans + rollback contract). Payload preview: the injected section is
named "Orch Memory" (source `orch_meta_brief`, injectionTarget `meta_user`), carrying the
curated brief per request; the reader is fail-soft (absent file -> no block, over-cap ->
8KB truncate, unchanged mtime -> cached). Subagent sessions stay clean: the injection gate
follows the native task-type gate. Restate that the install is reversible with the one-shot
reverse (section 4).

## 2. Install (temp-copy pipeline; verify-before-install)

1. Copy the live bundle to a temp directory. Never write the live path directly.
2. Apply `actions.json` to the copy with the search-based engine semantics: anchor count
   must be exactly 1 then splice; payload already present = already-applied no-op; any
   other state = abort with zero host contact.
3. `node --check` the patched copy. Failure = abort, keep the temp dir for forensics, report.
4. Post-checks: the registered count assertions from the actions' verify arrays, plus the
   patched sha256 cross-check against `manifest.patched_sha256_registered`.
5. Backup: copy the pristine live bundle to
   `<storage root>/patches/orch-meta-user/zcode.cjs.pre` (the rollback anchor; noti-rc
   same-family layout).
6. Atomically replace the live bundle with the patched copy (write a temp file on the same
   volume, then rename over the live path). Register the applied manifest at
   `<storage root>/patches/orch-meta-user/manifest.json` (status `applied`, applied_at,
   base + patched sha256, the patch_spans actually measured on the live base).

## 3. Live verification (canary probes; post-install)

1. Brief present: first line of the brief is the canary marker `orch-meta-user: v1`
   (missing -> trigger one gleaning round first).
2. Fresh interactive session probe: the session's meta_user block contains the canary line
   (the injected "Orch Memory" section). A subagent session shows no such section.
3. Mtime reread probe: append a fresh line to the brief -> within the next request the new
   line shows up (a one-request lag is the documented shape; the guard does one stat per
   request and re-reads only on mtime change).
4. Rollback drill (recommended on first install): run the reverse procedure against a fresh
   temp copy of the patched bundle and sha256-compare with the base pin - byte-exact before
   ever trusting the live rollback path.

## 4. Rollback (one-shot reverse)

1. Restore: either run the reverse semantics of `actions.json` against the live bundle
   (per span, in reverse order: locate the payload, swap back to the anchor literal; insert
   actions splice the payload out), or copy `zcode.cjs.pre` back over the live path.
2. Verify: sha256 equals the base pin again; the string `orch_meta_brief` occurs zero times
   in the restored bundle; a fresh session's meta_user is back to the native shape (canary
   line gone).
3. Register the rollback event in the runtime manifest (status `reverted`).

## 5. Host upgrade (re-pin flow)

After a host update the sha pin breaks by design: the Q12-01 dry-run leg reports the drift
and skips. Re-pin = re-measure every anchor on the new bundle (expect_count==1 each), re-
register the spans and the new base/patched sha pair, re-run all four verify legs, and wait
for the user to issue this command again - each install needs its own explicit user
authorization, a previous grant never carries over.
