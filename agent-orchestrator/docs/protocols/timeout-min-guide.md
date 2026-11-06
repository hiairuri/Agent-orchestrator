# timeout_min usage guide (headless dispatch timeout full chain)

- **Positioning**: usage guide for the dispatch tool's `timeout_min` parameter (the sole schema authority = the tool description "Runner timeout in minutes (default 240; on timeout the process tree is killed and timed_out:true is recorded)"; this document completes the full-chain semantics, selection, and the easy-to-confuse faces). The protocol body belongs to `card-result-dir.md` (the three-piece close-out markers) and `card-board.md` (the lease face)
- **Anchor declaration**: all line numbers in this document were measured at assembly time (v1.2 source); **line numbers are not referenced across versions** (l-20261022-6a14d6); function/constant-name dual anchors are the locating authority

---

## 1. Parameter semantics and the full chain (the runner side is parked at v1.6.0 - operational details moved with the archive; the anchor list stays here)

The -p channel has been peeled off and archived: parked/agent-orchestrator/ (recovery guide = the six steps in that directory's README). Anchor list:

- **Parameter semantics**: `Number(timeout_min)` finite and >0 -> `Math.floor`; 0/negative/NaN/missing -> falls back to the default **240** (`DISPATCH_DEFAULT_TIMEOUT_MIN`, server/runner dual-source same-value twin - changing the default means changing both in the same wave); no upper clamp.
- **Full-chain anchors**: runner argv `--timeout-min <N>` passed straight through; the timer starts after the runner spawns the CLI subprocess with `setTimeout(timeoutMin*60000)` (measuring the runner-side process-tree lifetime, not from the board dispatch moment); timeout action `killTree` (Windows `taskkill /PID <pid> /T /F` kills the whole tree including detached grandchildren; POSIX `kill(-pid, SIGKILL)`; a 5s fallback finish for stuck handles); close-out markers index.json `timed_out:true, outcome:"timeout"` (Q3b; the error/result sidecars land as usual per envelope parseability, and the wake event carries outcome/timed_out/exit_code alike).
- **Toxicity**: after a timeout close-out the index is already on disk -> the busy gate unlocks and re-dispatch is possible; **a mission whose run timed out gets no automatic failure mark** - failure marking goes through worker report or coordinator handling (result-dir is a diagnostic face, not a state face; the runner never touches the board).

## 2. Disambiguation against other "minutes/timeout" faces (same name, different things; do not conflate)

| Face | Value/default | Governs | Relation to timeout_min |
|---|---|---|---|
| board claim lease lease_minutes | default 30 (--claim-lease-min adjustable 1-1440); renewed by report | **board ownership**: lease timeout -> sweep reclaims the mission back to ready | **Two independent clocks, no linkage**: a session can outlive the lease or die before it. A long timeout_min is not a long lease; for long runs raise lease_minutes and have the worker renew via periodic reports |
| sentinel cfg.wake_timeout_min (bridge key) | sparse write (V7-05) -> sentinel-internal bridge to refire_gap_min | **sentinel re-fire interval** (the refire rhythm after a wake failure) | Unrelated to the runner timeout - it governs "how long after dispatch with no movement before re-poking", not "how long until the process is force-killed" |
| ORCH_DISPATCH_CAPTURE_MS | default 8000ms (cap 30s) | the combined capture window waiting for the receipt/fast-death before dispatch returns (parked) | Unrelated to timeout_min; raising it does not extend session lifetime |
| ORCH_DISPATCH_BUSY_STALE_MIN | default 120min | the busy gate's **over-age exemption** threshold (the sidecar release line when no index remains, parked) | A normal timeout close-out unlocks via the index; the exemption is only the backstop for force-kill residue |
| probe db.query timeout | 10s | the SQL subprocess | unrelated (probe card §2.1) |
| sandbox git phase cap | on the order of 60s | apply's per-phase git subprocesses | unrelated (sandbox card) |
| APPLY_INTENT_FRESH_MS | 10min | the apply<->discard intent mutual-exclusion window | unrelated |

## 3. Selection guide (headless parameters are parked - historical selection experience moved with the archive)

- The timeout line is a **backstop, not a target**; long runs must also check the relation between the claim's `lease_minutes` >= expected session length (or periodic worker report renewals) and ORCH_DISPATCH_BUSY_STALE_MIN (the lease-face protocol = `card-board.md`).
- Passing 0/negative is not "time out immediately" but a fallback to the default 240; **a session killed on timeout produces no report**; the coordinator handles it by the wake event's outcome="timeout" (close-out markers see §1).

## 4. Assertion anchors and maintenance

- **crv6-resilience DSP group** (v1.2 M3-1): seeding/close-out/backstop chain related assertions; the timeout kill-tree and timed_out marker legs live in the dispatch-runner contract comments and the WB-SRV series (wake event fields).
- **LM-05** (lint-manifest, M1-3 registration): DISPATCH_DEFAULT_TIMEOUT_MIN/killTree and other names grep-visible in source + this document exists and is non-empty.
- Maintenance: the default 240 has dual sources (server/runner) - change one, change both; a new same-named "timeout" face (a future nested, say) enters the §2 disambiguation table before implementation - the table exists precisely to prevent same-name confusion (the wake_timeout_min bridge key, per the V7-05 precedent).
