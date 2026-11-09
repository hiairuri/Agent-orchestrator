---
name: orch-meta-user-patch
description: "Authorization gate + install/rollback flow for the orch-meta-user host patch (meta_user per-request curated memory brief)"
---

Authorization gate for the Q-12 meta_user patch family (source assets:
`patches/orch-meta-user/`). Issuing this command IS the explicit user authorization for
installing that host patch. The double gate still applies in full: the patcher QA
(Q12-01..04 legs) must already have passed, and installation touches the live host
bundle - never patch in place, every byte runs through a temp copy first.

## 0. Preconditions (all must hold; abort with a report otherwise)

1. Base identity: sha256 of the live bundle
   `C:/Program Files/ZCode/resources/glm/zcode.cjs` equals the pin in
   `patches/orch-meta-user/manifest.json` (`base.sha256`). Mismatch = stale anchors =
   run the re-pin flow (section 5) instead, then come back for a fresh authorization.
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
