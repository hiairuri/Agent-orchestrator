# Cache policy: probe session read cache (LRU64 + SQL gate)

- **Positioning**: observe-side cache policy document (the contract document for the v0.7 V7-01/W-A §2 implementation; the probe protocol body belongs to `card-probe.md` - G1 virtual partitioning: probe is not physically split, the two are **separate**: the card governs the four-action protocol face, this document governs the "how to save bytes on same-parameter re-probes" cache mechanism face)
- **Design motive**: the cache turns "do not re-probe" from model discipline into mechanism - a same-parameter re-probe folds into a ~100B stub (W-A §2: collapsed at the single distribution choke point toolProbe)
- **Anchor declaration**: all line numbers in this document were measured at assembly time (v1.2 source); **line numbers are not referenced across versions** (l-20261022-6a14d6); function/constant-name dual anchors are the locating authority

---

## 1. Cache scope (admission gate)

| Item | Content | Anchor |
|---|---|---|
| Cacheable actions | `file.head` / `file.grep` / `bin.inspect` (the three of PROBE_CACHE_ACTIONS) | :9098 |
| **SQL gate (never cached)** | `db.query` excluded entirely - the SQLite file is mutable by external processes, mtime is not a trustworthy invalidation factor, excluded by construction | :9091-9093 |
| **Pagination gate (never cached)** | Calls carrying page_token neither read nor write the cache - under offset semantics a stub is meaningless; pagination freshness is guarded by the token's own sz binding (probeDecodeToken) | :9093-9095 |
| **Escape gate (no_cache)** | `no_cache:true`: skips the cache and forces a full re-read, and **that call's result is not written to the cache** (first probe with no_cache leaves zero cache residue) | :9144; schema :9892-9896 |
| Qualified responses only | Only responses with `ok===true` and a string hash enter the cache (ToolError/malformed responses do not) | :9162-9163 |

## 2. Key and invalidation (no-notification protocol)

| Item | Content | Anchor |
|---|---|---|
| Key shape | `JSON([action, flatArgs, mtimeMs, size])` - flatArgs = the canonical form of the arguments after removing page_token/no_cache, sorting keys, and dropping undefined | probeCacheKey :9105-9112 |
| Invalidation factors | **mtimeMs+size, two factors embedded in the key** - any host write moves the key -> miss -> full re-read, with no write-notification protocol at all (same philosophy as the page_token sz binding) | :9095-9097; :9101-9104 |
| Why two factors | V7-01/CACHE-06 lesson: a single mtime cannot survive same-millisecond writes; reading bytes+mtimeMs together is stable | :10142-10145, same argument |

## 3. Stub and LRU64

| Item | Content | Anchor |
|---|---|---|
| Capacity | PROBE_CACHE_MAX_ENTRIES = **64** entries; each envelope itself <= 10KB (probe's own cap) -> whole cache <= 640KB, no second byte cap | :195-198 |
| Eviction | Map insertion order is the LRU: on hit delete+set touches (touch); over 64 evicts the oldest (earliest insertion order) | :9099; :9157-9166 |
| Stub shape | `{ok, tool, action, path, cached:true, cached_at, prior_hash, prior_bytes, note}` - **a machine-honest pointer, never carries a payload**; the note declares the no_cache:true escape face | probeCacheStub :9114-9130 |
| Touch path | the toolProbe choke: cacheable action AND no page_token AND no no_cache -> resolve path+stat -> look up the cache -> on hit return the stub / on miss execute and insert into the cache | toolProbe :9142-9172 |

**Residual scenario (the reason no_cache exists)**: the first full response has already been condensed/trimmed out of the session context, leaving only a hash pointer - at that point the context the stub points to is no longer visible, and `no_cache:true` forces a true re-read (:9114-9117 comment semantics).

## 4. Invalidation semantics

| Case | Behavior | Class |
|---|---|---|
| Same-parameter re-probe (file unchanged) | stub (cached:true + prior_hash = previous hash) | by design |
| Re-probe after the file was written | key moved -> miss -> full re-read (new hash enters the cache) | self-healing (no notification) |
| Any db.query re-probe | always full (SQL gate) | by design |
| Paginated calls | always bypass cache read and write | by design |
| no_cache calls | always full and do not pollute the cache (subsequent same-parameter calls still use the original cache entry) | by design |
| First probe with no_cache | zero cache residue (subsequent re-probes are also full) | by design (CACHE-03) |
| stat failure (path unresolvable) | conservative fallback: pass through to the action handler (the handler raises its own ToolError) | degraded passthrough |
| Process restart | in-memory cache cleared (session-level cache, no persistence face) | by design |

## 5. Assertion anchors

- **probe-caps**: the CACHE-01..06 dedicated group - CACHE-01 first probe full / same-parameter folds to a stub (stub key-face pre-sorting assertion), CACHE-02 three actions cacheable + db.query explicitly excluded, CACHE-03 no_cache always full with zero residue + schema parameter addition, CACHE-04 pagination never reads or writes the cache (a mistaken write is caught on the spot by the first-page stub's prior_hash) - tests/suites/probe-caps.mjs.
- **LM-05** (lint-manifest, M1-3 registration): PROBE_CACHE_ACTIONS/PROBE_CACHE_MAX_ENTRIES/probeCacheKey/probeCacheStub etc. grep-visible in mcp/tool-probe.mjs + this document exists and is non-empty.

## 6. Maintenance rules

- New cacheable action: add to PROBE_CACHE_ACTIONS + this document's §1 admission gate + the probe-caps CACHE group assertions, all three in the same wave; **externally mutable data-source actions default to exclusion** (the db.query precedent - untrustworthy mtime means no cache).
- Key shape change = cache semantics change: sync the page_token sz binding philosophy explanation and the CACHE assertion group; stuffing a payload into a stub is forbidden (the byte-saving premise, no compromise opening).
- Capacity change (64): recompute the total cap (entries x 10KB) and record the literal in this document's §3; if probe-caps locks the literal value, change it in the same wave.
