// agent-orchestrator orch server — tool registry：TOOL_HANDLERS + TOOLS 12 工具 schema（机械拆分自 server.mjs L9658-10430）
import { PREFIX } from "./server-core.mjs";
import { toolBoard } from "./tool-board.mjs";
import { toolReport } from "./tool-report.mjs";
import { toolMailbox } from "./tool-mailbox.mjs";
import { toolSpawnAgent } from "./tool-spawn.mjs";
import { toolContextPack } from "./tool-pack.mjs";
import { toolDispatch } from "./tool-dispatch.mjs";
import { toolResume } from "./tool-resume.mjs";
import { toolLessons } from "./server-lessons.mjs";
import { toolSandboxApply, toolSandboxDiscard } from "./tool-sandbox.mjs";
import { toolAgentHarvest } from "./tool-harvest.mjs";
import { toolProbe } from "./tool-probe.mjs";
import { toolTrajectory } from "./server-trajectory.mjs";
/* ------------------------------------------------------------------ */
/* tool registry                                                       */
/* ------------------------------------------------------------------ */

const TOOL_HANDLERS = {
  [PREFIX + "board"]: toolBoard,
  [PREFIX + "report"]: toolReport,
  [PREFIX + "mailbox"]: toolMailbox,
  [PREFIX + "spawn_agent"]: toolSpawnAgent,
  [PREFIX + "context_pack"]: toolContextPack,
  [PREFIX + "dispatch"]: toolDispatch,
  [PREFIX + "resume"]: toolResume,
  [PREFIX + "lessons"]: toolLessons,
  [PREFIX + "sandbox_apply"]: toolSandboxApply,
  [PREFIX + "sandbox_discard"]: toolSandboxDiscard,
  [PREFIX + "agent_harvest"]: toolAgentHarvest,
  [PREFIX + "probe"]: toolProbe,
  // v1.6 W-t: the 13th tool (appended last — probe=11/dispatch=12 zero-drift precedent).
  [PREFIX + "trajectory"]: toolTrajectory,
};

const TOOLS = [
  {
    name: PREFIX + "board",
    description:
      "Persistent mission board: create, query, and acknowledge missions; claim pool tasks; and P2P ask/answer between missions.\n\n" +
      "Usage:\n" +
      "- The data source for cross-session resume; action semantics are on the `action` parameter, the behavior contract in SKILL section 14.\n" +
      "- upsert shallow-merges `mission` fields (dispatch/blocked/pack one level deeper); list excludes closed missions by default.\n" +
      "- upsert/ack return {ok,id,status}; list rows are compact (id/title/status/question/unacked/unread + counters); get omits timeline/original_prompt — pass view:\"full\" for the verbatim record.\n" +
      "- ack marks a result as seen - use it for deferred handling too, so the mission stops appearing as a suspected wake failure.\n" +
      "- claim is a CAS claim of a ready mission: it becomes running with a lease; report renews the lease, timeout returns it to ready.\n" +
      "- p2p_ask/p2p_answer is server-arbitrated peer Q&A with a two-way echo; ask only from a blocked/question mission.\n" +
      "- Do NOT pass the read-only fields owner/claim/ack in `mission` - they are ignored.",
    inputSchema: {
      type: "object",
      properties: {
        action: {
          enum: ["upsert", "get", "list", "ack", "claim", "p2p_ask", "p2p_answer"],
          description:
            "upsert=create or merge-update; get=fetch by id; list=filtered list (closed excluded by default); " +
            "ack=acknowledgement; claim=pool CAS claim (ready -> running); p2p_ask/p2p_answer=server-arbitrated peer Q&A (see the p2p_* params)",
        },
        to_mission_id: {
          type: "string",
          description: "p2p_ask target mission id (the answering side; must exist and be non-terminal)",
        },
        to_worker: {
          type: "string",
          description: "p2p_ask designated answering worker (must be the mission's holder when it has one)",
        },
        question: {
          type: "string",
          description:
            "p2p_ask question body (truncated at 4000 chars; full text stored in the p2p record; both timelines receive the truncated echo)",
        },
        p2p_id: {
          type: "string",
          description: "p2p_answer target record id (from the p2p_ask response; only open records can be answered)",
        },
        answer: {
          type: "string",
          description:
            "p2p_answer body (truncated at 4000 chars; advisory data - the asking mission ingests it through its own report)",
        },
        // v1.1.1 W20 DP hotfix: p2p_ask/p2p_answer read args.token for the
        // report-gate mirror (p2pTokenGate), but the schema never declared it —
        // schema-validating MCP clients strip undeclared arguments, so every
        // subagent p2p call arrived token-less and was refused. Declaring it here
        // is the whole fix: the handler face is unchanged.
        token: {
          type: "string",
          description:
            "worker dispatch token (this mission's dispatch.token): required by p2p_ask/p2p_answer authentication " +
            "whenever the mission already carries one; same [token] line as the pack CONTRACT",
        },
        mission: {
          type: "object",
          description:
            "upsert field pack; shallow-merged into the existing record (dispatch/blocked/pack merge one level deeper)",
          properties: {
            id: {
              type: "string",
              description: "auto-generated as m-<YYYYMMDD-HHmmss>-<4hex> by default",
            },
            title: { type: "string" },
            original_prompt: {
              type: "string",
              description: "verbatim dispatch prompt; the key input for cross-session resume",
            },
            agent_type: {
              type: "string",
              description: "e.g. agent-orchestrator:orch-worker",
            },
            model: { type: ["string", "null"] },
            status: {
              enum: [
                "drafted",
                "dispatched",
                "running",
                "blocked",
                "question",
                "done",
                "failed",
                "skipped",
                "ready",
                "resumed",
                "closed",
              ],
            },
            blockedBy: {
              type: "array",
              items: { type: "string" },
              description:
                "upstream mission_id list (DAG): unlocks to ready when all upstream are done/skipped/closed; " +
                "any failed/skipped upstream cascades skipped(upstream_failed). Forward references allowed; cycles rejected",
            },
            skippedReason: {
              type: ["string", "null"],
              description: "terminal reason for skipped (currently only upstream_failed, written by the cascade)",
            },
            // v1.1.1 W20 DP hotfix (same class as the board top-level token):
            // toolBoard validates and stores these upsert fields, but they were
            // missing from the schema — schema-validating clients stripped them,
            // so scope registration silently vanished and the strict tier could
            // never engage.
            scope_paths: {
              type: "array",
              items: { type: "string" },
              description:
                "write allowlist (max 32, F1-normalized); each upsert replaces the full list — context_pack also registers it",
            },
            strict_scope: {
              type: "boolean",
              description:
                "scope conflict tier: true = reject-before-write on any overlap with a live mission, absent = collect scope_warnings",
            },
            qa: {
              type: "object",
              properties: {
                verdict: { enum: ["pass", "fail"] },
                by: { type: "string" },
                mission_id: { type: "string", description: "review mission id (traceability)" },
                at: { type: "string" },
                note: { type: "string" },
              },
              description:
                "review verdict (the sandbox_apply gate); the coordinator copies it onto this mission after the review mission is done",
            },
            owner: {
              type: ["string", "null"],
              description: "read-only: current claimer, maintained by the claim action; ignored when passed via upsert",
            },
            claim: {
              type: ["object", "null"],
              description:
                "read-only: {worker, token, claimedAt, leaseUntil} lease; renewed by claim/report, reclaimed on timeout; ignored when passed via upsert",
            },
            dispatch: {
              type: "object",
              properties: {
                // v1.2 M5-1：mode 枚举加 nested（组装出口；headless 系 W3 M3-1 在案补齐）
                mode: { enum: ["agent", "workflow", "headless", "nested"] },
                agent_id: {
                  type: ["string", "null"],
                  description: "agent_<uuid>",
                },
                task_id: {
                  type: ["string", "null"],
                  description: "background task id",
                },
                run_id: {
                  type: ["string", "null"],
                  description: "workflow run id",
                },
                run_in_background: { type: "boolean" },
                session_id: {
                  type: ["string", "null"],
                  description: "dispatch session id (from the SessionStart injection)",
                },
                token: { type: "string", description: "8-hex dispatch token" },
                spawned_by_session: {
                  type: ["string", "null"],
                  description:
                    "coordinator session id that issued the spawn (v1.2 M3-1: written by dispatch from coord-session.txt; W9 scoping ownership face; null = anchor absent)",
                },
              },
            },
            pack: {
              type: "object",
              properties: {
                path: { type: "string" },
                variants: { type: "array", items: { type: "string" } },
                persona: {
                  type: "string",
                  description: "persona file registered by context_pack persona_path (dispatch resolution step 2)",
                },
              },
            },
            artifacts: {
              type: "array",
              items: {
                type: "object",
                properties: { path: { type: "string" }, note: { type: "string" } },
              },
            },
            output_files: {
              type: "array",
              items: { type: "string" },
              description: "output file paths from the completion notice (fallback when TaskOutput is unavailable)",
            },
            blocked: {
              type: "object",
              properties: {
                question: { type: ["string", "null"] },
                asked_at: { type: ["string", "null"] },
                answered: { type: "boolean" },
                answer: { type: ["string", "null"] },
                answered_at: { type: ["string", "null"] },
              },
            },
            ack: {
              type: ["object", "null"],
              description:
                "read-only: ack marker {at, by, note}; maintained by board ack or mailbox answer/close; ignored when passed via upsert",
            },
            // v1.1.1 W20 DP hotfix (same class): transient upsert-gate inputs read
            // from the mission patch. Undeclared → schema-validating clients drop
            // them → terminal revival and the closed confirm gate became unreachable.
            reopen: {
              type: "boolean",
              description:
                "transient gate input: true revives failed/skipped → drafted (requires note as the reason); never stored",
            },
            note: {
              type: "string",
              description: "transient gate input: reopen reason (top-level `note` is the ack note instead)",
            },
            close_confirmed: {
              type: "boolean",
              description:
                "transient gate input: required for an external upsert into status:\"closed\" (one-shot confirmation); never stored",
            },
          },
        },
        mission_id: { type: "string" },
        view: {
          enum: ["compact", "full"],
          description:
            "action=get detail view: compact (default) omits timeline/original_prompt; full replays them verbatim",
        },
        worker: {
          type: "string",
          description: "required for action=claim: claimer name (e.g. orch-pool#1)",
        },
        lease_minutes: {
          type: "number",
          description:
            "lease minutes for action=claim (>=1, default claim_lease_min=30); report renews it; on timeout the mission returns to ready",
        },
        note: {
          type: "string",
          maxLength: 200,
          description: 'optional note for action=ack, e.g. "deferred by user"',
        },
        filter_status: { type: "array", items: { type: "string" } },
      },
    },
  },
  {
    name: PREFIX + "report",
    description:
      "Report a mission event (milestone/blocked/question/done) to the coordinator mailbox and record it on the mission board.\n\n" +
      "Usage:\n" +
      "- Call at each verifiable unit and once at the end; include artifacts paths on done.\n" +
      "- The event protocol is defined in the dispatch pack's CONTRACT section.\n" +
      "- summary is capped at 200 characters; put long findings in details.\n" +
      "- question is required for kind=blocked and kind=question.\n" +
      "- lessons and manifest_entries apply to done only; lesson_refs cites pack lessons that proved wrong.",
    inputSchema: {
      type: "object",
      required: ["mission_id", "worker", "kind", "summary"],
      properties: {
        mission_id: { type: "string", description: "Mission id" },
        worker: { type: "string", description: "Worker name, e.g. orch-worker#2" },
        token: { type: "string", description: "[token] line from the pack CONTRACT header" },
        kind: { enum: ["milestone", "blocked", "question", "done"] },
        summary: { type: "string", maxLength: 200 },
        details: { type: "string", description: "Long-form findings" },
        artifacts: { type: "array", items: { type: "string" }, description: "Output file paths" },
        files_touched: {
          type: "array",
          items: { type: "string" },
          maxItems: 50,
          description: "Changed paths; audited against the mission scope for milestone/done only",
        },
        manifest_entries: {
          type: "array",
          maxItems: 12,
          description:
            "Done only: manifest entry claims (max 12); over-cap and malformed entries are soft-handled, never an error",
          items: {
            type: "object",
            required: ["layer", "type", "title", "ref"],
            properties: {
              layer: { enum: ["T0", "T1", "T2"], description: "Highest attainable layer claimed" },
              type: {
                enum: ["assertion", "env_fact", "anchor", "conclusion", "directive"],
                description: "Closed five-value enum; summary is invalid",
              },
              title: { type: "string", description: "Max 60 chars; truncated by the writer" },
              text: { type: "string", description: "T0=verbatim / T1=summary / T2=omit" },
              ref: {
                type: "object",
                properties: {
                  path: { type: "string", description: "Source file path" },
                  loc: { type: "string", description: "Section title / L120-L180 / assertion id" },
                },
              },
            },
          },
        },
        question: {
          type: "string",
          description: "Required for kind=blocked and kind=question",
        },
        urgent: {
          type: "boolean",
          description: "Flag only; direct answers still go through SendMessage/RespondToCoordinator",
        },
        lessons: {
          type: "array",
          maxItems: 3,
          description:
            "Done only: up to 3 candidate lessons (trigger/fix) for the coordinator to distill on ack; ignored for other kinds",
          items: {
            type: "object",
            required: ["trigger", "fix"],
            properties: {
              type: { enum: ["error-fix", "pitfall", "preference", "env-fact"], description: "Defaults to pitfall" },
              trigger: { type: "string", maxLength: 120, description: "Max 120 chars: the situation that caused the pitfall" },
              fix: { type: "string", maxLength: 200, description: "Max 200 chars: what to do next time" },
              lesson: {
                type: "string",
                maxLength: 200,
                description: "Optional one-line lesson; distilled by the coordinator on promotion by default",
              },
            },
          },
        },
        lesson_refs: {
          type: "array",
          items: { type: "string" },
          description:
            "Optional for kind=blocked/question: pack lesson ids ([type·id] prefixes in the pack LESSONS section) that proved wrong; " +
            "the server demotes them and may auto-retire them at the floor (SKILL section 10)",
        },
      },
    },
  },
  {
    name: PREFIX + "mailbox",
    description:
      "Coordinator mailbox: peek surveys unread events without consuming, read consumes them atomically, " +
      "answer logs a reply, gc cleans up and archives.\n\n" +
      "Usage:\n" +
      "- Use read to take over subagent results (the wake-up handover path); use peek to survey without consuming.\n" +
      "- kind and mission_id narrow the listing; limit caps results (default 20).\n" +
      "- answer records the coordinator's reply to a blocked/question mission and returns the recommended SendMessage call; it does not message the worker directly.\n" +
      "- gc removes events older than keep_days (default 14).",
    inputSchema: {
      type: "object",
      properties: {
        action: { enum: ["peek", "read", "answer", "gc"] },
        mission_id: { type: "string" },
        kind: { enum: ["milestone", "blocked", "question", "done"] },
        limit: { type: "number", default: 20 },
        answer: { type: "string", description: "Required for action=answer" },
        keep_days: { type: "number", default: 14, description: "gc threshold in days (default 14)" },
      },
    },
  },
  {
    name: PREFIX + "spawn_agent",
    description:
      "Create a custom subagent persona at <project>/.zcode/agents/<name>.md from an archetype template; it registers in new sessions.\n\n" +
      "Usage:\n" +
      "- To use it in the current session, dispatch a general-purpose agent with the file body as the prompt.\n" +
      "- tools overrides the archetype toolset and MUST keep the report tool's full name.\n" +
      "- system_prompt is appended after the archetype body as the role spec.\n" +
      "- model defaults to the session model; pass providerId/modelId to pin one.",
    inputSchema: {
      type: "object",
      required: ["name", "description"],
      properties: {
        name: { type: "string", pattern: "^[a-z0-9][a-z0-9-]{0,63}$" },
        description: { type: "string", minLength: 10 },
        archetype: { enum: ["worker", "scout", "reviewer"], default: "worker" },
        model: {
          type: "string",
          description: "providerId/modelId; defaults to the session model",
        },
        max_turns: { type: "number" },
        tools: {
          type: "array",
          items: { type: "string" },
          description: "Override of the archetype toolset",
        },
        system_prompt: { type: "string", description: "Role spec appended after the archetype body" },
        overwrite: { type: "boolean", default: false },
      },
    },
  },
  {
    name: PREFIX + "context_pack",
    description:
      "Materialize a context pack (1-8 variants) and return the dispatch header and token; pack rules in SKILL section 14.\n\n" +
      "Usage:\n" +
      "- Copy upstream context verbatim; the subagent was not present when it was produced.\n" +
      "- inputs are frozen at pack time; later upstream updates do not propagate.\n" +
      "- scope_paths replaces oob_allowlist as the sandbox write allowlist; isolation=worktree creates the sandbox.",
    inputSchema: {
      type: "object",
      required: ["mission_id", "title", "task"],
      properties: {
        mission_id: { type: "string", description: "Mission id" },
        title: { type: "string", description: "Pack title" },
        task: { type: "string", description: "Task for the subagent" },
        read_first: { type: "array", items: { type: "string" }, description: "Files to read first" },
        rules: { type: "array", items: { type: "string" }, description: "Pack rules" },
        return_format: { type: "string", description: "Return template" },
        upstream_context: {
          type: "string",
          description: "Upstream content, injected verbatim",
        },
        variants: { type: "number", minimum: 1, maximum: 8, default: 1 },
        variant_axes: {
          type: "array",
          items: { type: "string" },
          description: "One divergence axis per variant (same length as variants)",
        },
        isolation: {
          enum: ["worktree", "none"],
          description:
            "worktree creates a git worktree sandbox (SKILL section 12); none keeps in-repo (default from userConfig sandbox_default)",
        },
        oob_allowlist: {
          type: "array",
          items: { type: "string" },
          description: "Repo-relative path-prefix allowlist; empty = all paths; legacy alias, prefer scope_paths",
        },
        scope_paths: {
          type: "array",
          items: { type: "string" },
          description: "Write allowlist, max 32 entries; see SKILL section 14 TS-3",
        },
        budget: {
          enum: ["S", "M", "L"],
          description: "S/M/L step budget; see SKILL section 14 TS-3",
        },
        inputs: {
          type: "array",
          items: { type: "string" },
          description: "Upstream mission ids, max 4; see SKILL section 14 TS-3",
        },
        share_node_modules: {
          type: "boolean",
          description: "Auto-share node_modules via junction (SKILL section 12)",
        },
        extra: {
          type: "string",
          description: "Coordinator note; appended verbatim as the EXTRA section",
        },
        worker_name: {
          type: "string",
          description: "Worker name for the pack header (matches the background Agent task name)",
        },
        persona_path: {
          type: "string",
          description:
            "v1.1.1: register the persona file for the dispatch launcher (mission.pack.persona); absent → no pack/board byte change",
        },
        mirror_digest: {
          type: "boolean",
          default: false,
          description: "Set to true to append a recent-context digest (context-mirror tail)",
        },
      },
    },
  },
  {
    name: PREFIX + "resume",
    description:
      "Resume briefing from board+mailbox: a recommended_action per unclosed mission - same-session chat, workflow resume, or cross-session re-dispatch.\n\n" +
      "Usage:\n" +
      "- Call once at session start; one call covers the whole board.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: {
          type: "string",
          description: "Current session id; separates same-session from cross-session advice",
        },
      },
    },
  },
  {
    name: PREFIX + "lessons",
    description:
      "Learning memory for orchestration lessons: list/add/promote/promote_batch/retire/stage (contract in SKILL section 10).\n\n" +
      "Usage:\n" +
      "- Candidates are produced by report(kind=done, lessons=[...]).\n" +
      "- list: ranked by score (default status=active); `q` matches case-insensitive substrings of trigger/lesson/fix.\n" +
      "- add: coordinator-direct insert; `contradicts=<old id>` marks the old entry superseded and records a counter-example.\n" +
      "- promote: refine a candidate to active; same trigger+fix auto-merges hits/confidence; contradictions go through add's contradicts. " +
      "Global: target=\"global\" 跨项目晋升全端库 (merge or create scope=global fleet-wide; refs=[源条 id, 源项目路径, root_id] backlink; source entry untouched).\n" +
      "- promote_batch: transactional batch promote of `ids` — every item follows the single promote semantics (merge key/hits/contradicts); any invalid id/status/refinement rejects the whole batch with zero writes, and each touched library is written once after the batch succeeds. Items are id strings or {id, target?, type?, trigger?, lesson?, fix?, contradicts?} overrides; `target` defaults to the call-level target.\n" +
      "- stage: 主控随手暂存（ORCHTEMP）。写 source=\"orchestrator\"/candidate/confidence=0；不合并不注入；由归敛代理消费（置 retired+视图层落笔）。trigger/fix 必填。\n" +
      "- retire: manual retirement with a reason.\n" +
      "- list with token (v1.6 W4): per-reader hash baseline — no-new→short answer, new→increment + baseline roll-forward; " +
      "ANY write action carrying a token is rejected (worker read-only gate).",
    inputSchema: {
      type: "object",
      properties: {
        action: { enum: ["list", "add", "promote", "promote_batch", "retire", "stage"] },
        // v1.6 W4 (design §2.4) + 修订轮 F-1: declare the optional token so
        // schema-validating MCP clients don't strip it (p2p token precedent,
        // DP hotfix v1.1.1 W20 — same fix shape, handler face unchanged).
        token: {
          type: "string",
          description:
            "Optional for list: 哈希读面 reader 键（worker=派发 token/主控=coord-session id）——" +
            "无新→短答/有新→增量+读后基线前滚；写闸判据：携 token 的 add/stage/promote/promote_batch/retire 一律拒（worker 只读面）",
        },
        id: { type: "string", description: "promote/retire target entry id (l-...)" },
        ids: {
          type: "array",
          description:
            "promote_batch: non-empty list of ids (string, or {id, target?, type?, trigger?, lesson?, fix?, contradicts?} for per-item overrides); all-or-nothing",
          items: {
            oneOf: [
              { type: "string" },
              {
                type: "object",
                properties: {
                  id: { type: "string" },
                  target: { enum: ["project", "global"] },
                  type: { enum: ["error-fix", "pitfall", "preference", "env-fact"] },
                  trigger: { type: "string" },
                  lesson: { type: "string" },
                  fix: { type: "string" },
                  contradicts: { type: "string" },
                },
                required: ["id"],
              },
            ],
          },
        },
        status: {
          type: "string",
          description: "list filter: active|candidate|superseded|retired|all, default active",
        },
        type: {
          enum: ["error-fix", "pitfall", "preference", "env-fact"],
          description: "Required for add (optional for stage, default pitfall); optional list filter",
        },
        q: {
          type: "string",
          description: "list keyword filter (case-insensitive substring over trigger/lesson/fix)",
        },
        trigger: { type: "string", maxLength: 120, description: "Required for add/stage; optional refinement for promote" },
        lesson: { type: "string", maxLength: 200, description: "Optional for add/promote/stage: one-line lesson" },
        fix: { type: "string", maxLength: 200, description: "Required for add/stage; optional refinement for promote" },
        mission_id: {
          type: "string",
          description: "Optional for add/stage: source mission (goes into refs/counter_refs)",
        },
        contradicts: {
          type: "string",
          description: "Optional for add: id of the entry this one disproves; it becomes superseded and a counter-example is recorded",
        },
        target: {
          enum: ["project", "global"],
          description:
            "Optional for promote/promote_batch (default project): project (this library) or global (fleet-wide; standard = cross-project reproduced >=2, " +
            "or score>=0.7 with hits>=3 and age>=7d; evidence returned in the standard key; the gleaner decides)",
        },
        note: {
          type: "string",
          maxLength: 200,
          description: 'Optional for stage: placement hint (e.g. "pin: AGENTS.md") consumed by the gleaner',
        },
        reason: { type: "string", maxLength: 200, description: "retire note" },
        limit: { type: "number", default: 8, description: "list return cap (default 8)" },
      },
    },
  },
  {
    name: PREFIX + "sandbox_apply",
    description:
      "Sandbox finalize (gate tool): merge the sandbox branch back into the main repo and remove the worktree. " +
      "Gate: mission done with qa.verdict=pass.\n\n" +
      "Usage:\n" +
      "- Flow: main-repo status survey, out-of-scope allowlist detection, merge-tree conflict pre-check, " +
      "clean merge+commit, worktree removal, board closed with auto-ack.\n" +
      "- On conflict: isError with the conflict list and merge-agent guidance; the main repo is left untouched.\n" +
      "- allow_dirty is the escape hatch for uncommitted main-repo changes; the qa gate cannot be bypassed.",
    inputSchema: {
      type: "object",
      required: ["mission_id"],
      properties: {
        mission_id: { type: "string" },
        allow_dirty: {
          type: "boolean",
          default: false,
          description:
            "Set to true to proceed when the main repo has uncommitted changes (confirm they are yours, not worker pollution); the qa gate still applies",
        },
      },
    },
  },
  {
    name: PREFIX + "sandbox_discard",
    description:
      "Discard a sandbox: delete the sandbox branch and worktree with zero changes to the main repo; " +
      "the mission status is untouched (re-dispatch or close separately).\n\n" +
      "Usage:\n" +
      "- Use for verdict=fail, worker scope violations, or voided tasks.\n" +
      "- Idempotent: succeeds when the branch/worktree no longer exists.",
    inputSchema: {
      type: "object",
      required: ["mission_id"],
      properties: { mission_id: { type: "string" } },
    },
  },
  {
    name: PREFIX + "agent_harvest",
    description:
      "Read-only harvest of a subagent rollout transcript tail, rendered as role-labeled text (user/assistant/tool-call lines).\n\n" +
      "Usage:\n" +
      "- Locate by any one of mission_id, agent_id, or session_id.\n" +
      "- The tail is the full conversation embedded in the last model-io record; works across sessions when TaskOutput is unavailable; terminal deliverables still follow report artifacts.\n" +
      "- tail=0 is probe mode: no transcript echo, only usage/file_bytes/messages_kind metadata for coordinator sampling.",
    inputSchema: {
      type: "object",
      properties: {
        mission_id: {
          type: "string",
          description: "Harvest by mission (resolves dispatch.agent_id to sess_subagent_agent_<id>); one locator suffices",
        },
        agent_id: { type: "string", description: "agent_<uuid> (the sess_subagent_agent_ prefix is added automatically)" },
        session_id: { type: "string", description: "Full session id (sess_...; used as-is when already prefixed)" },
        tail: {
          type: "number",
          default: 12,
          description:
            "Number of trailing messages to render (1-100, default 12; earlier messages omitted); 0 = probe mode",
        },
        max_chars: {
          type: "number",
          default: 8000,
          description: "transcript char cap (200-48000, default 8000; the tail is kept when exceeded)",
        },
        include_tools: {
          type: "boolean",
          default: true,
          description: "Set to true (default) to render assistant tool-call lines (-> ToolName(input...))",
        },
      },
    },
  },
  {
    // v0.6 (V6-01, A6): server-enforced SKILL §15.4 probe caps — the context-
    // economy pillar #2. Dual-side usable (coordinator + subagents), so it is
    // deliberately NOT in MCP_DISALLOWED.
    name: PREFIX + "probe",
    description:
      "Structured read-only probe: server-enforced caps from SKILL section 15.4 - max 50 rows and 10KB per response, pagination via page_token.\n\n" +
      "Usage:\n" +
      "- Every ok response is a summary JSON envelope (rows_truncated/bytes/hash/page_token), never a raw dump.\n" +
      "- db.query: restricted read-only SQL on a SQLite file (single SELECT/WITH; bare SELECT * banned except COUNT(*); " +
      "built-in LIMIT <= 100; 50 rows per page).\n" +
      "- file.head: first <= 50 lines; tail=true reads the last <= 50 lines (log-tail semantics, terminal, no pagination).\n" +
      "- file.grep: server-side grep -m semantics; max_count <= 50 per page; ignore_case available.\n" +
      "- bin.inspect: returns type/size/sha256/first 256 bytes only.\n" +
      "- Session read cache: a repeated file action with identical arguments returns a stub (cached:true+prior_hash, no payload); " +
      "no_cache=true forces a full re-read; db.query and continuation pages are never cached.\n" +
      "- Paths may be any readable file - the probe enforces caps, not sandbox scope. Usable by coordinator and subagents.",
    inputSchema: {
      type: "object",
      required: ["action"],
      properties: {
        action: {
          enum: ["db.query", "file.head", "file.grep", "bin.inspect"],
          description:
            "db.query=restricted read-only SQL; file.head=first/last <= 50 lines; file.grep=matching lines (grep -m); bin.inspect=binary summary",
        },
        path: {
          type: "string",
          description:
            "Target path (absolute, or project-relative); the SQLite database file for db.query, a plain file otherwise",
        },
        query: {
          type: "string",
          description:
            "Read-only SQL for db.query: single SELECT/WITH; no * (COUNT(*) excepted), no INTO, no comments, no multi-statements; built-in LIMIT <= 100",
        },
        lines: {
          type: "number",
          description: "file.head row count (1-50, default 50; capped to 50)",
        },
        tail: {
          type: "boolean",
          description: "file.head: set to true to read the last <= 50 lines (log-tail semantics; terminal, no page_token)",
        },
        pattern: {
          type: "string",
          description: "JS regex for file.grep (<= 500 chars)",
        },
        max_count: {
          type: "number",
          description: "file.grep max matching rows (grep -m; 1-50, default 50)",
        },
        ignore_case: {
          type: "boolean",
          description: "file.grep case-insensitive matching (grep -i)",
        },
        page_token: {
          type: "string",
          description:
            "Pass back the previous probe response's page_token verbatim to continue; bound to the action - a changed action/file is rejected",
        },
        no_cache: {
          type: "boolean",
          description:
            "Set to true to skip the session read cache and force a full re-read (this result is not cached)",
        },
      },
    },
  },
  {
    // v1.1.1 W20: the 12th tool (appended last so the legacy 0.4.1 ten stay a
    // prefix and probe keeps its 11th position — zero drift for old readers).
    name: PREFIX + "dispatch",
    description:
      "Dispatch launcher: mint the dispatch credential set (numbered receipt). Single form — nested (v1.2 M5-1 assembly exit; v1.6 W-p: no spawn; v1.6 W3a: the receipt is a NUMBER, not a text — the assembled first message is retired; the former headless -p channel is parked at v1.6 W-p, archived under parked/agent-orchestrator/).\n\n" +
      "Usage:\n" +
      "- Coordinator-only. Dispatch surface = board upsert → context_pack → dispatch(mission_id); no prompt assembly anywhere (v1.6 W3a assembly retirement).\n" +
      "- Pack resolves mission.pack.path → pack_path → <root>/packs/<mission_id>/pack.md.\n" +
      "- Numbered receipt (v1.6 W3a): the worker fetches its own pack (pointer discipline). The coordinator fills the fixed DP-3 pointer template (SKILL §2.3/§3) with the receipt fields — {pack_path, worker, channel, token} — verbatim, no expansion, no rewriting the three CONTRACT lines; the first message is the template and nothing else. bg-gate checks the CONTRACT head on the host Agent call (runtime presence face).\n" +
      "- mode=nested (v1.6 W-p: the only enum value, default): no process is spawned. Bookkeeping: dispatch.mode=nested + spawned_by_session; agent_id stays null (the coordinator is in-session and receives the result directly, so the sentinel does not watch nested missions by default). Embedded checks (dispatch discipline enforced by the tool face, §8.7): pack CONTRACT token must equal mission.dispatch.token (p2pTokenGate semantics; strict-tokens closes the no-token face) + the yolo scope_paths gate (scout/reviewer exempt — v1.6 W3b dual-role: gleaner persona removed). Busy gate (board semantics): a nested-dispatched mission still awaiting its worker result rejects a second dispatch — recovery = board upsert status:\"drafted\" then re-dispatch.\n" +
      "- Returns {ok, mode:\"nested\", mission_id, worker, channel, token, pack_path, lock_hold_ms} (v1.6 W3a numbered field set — prompt/prompt_path/chars/persona retired with the assembly chain); completion arrives through the host Agent return + the worker's report.",
    inputSchema: {
      type: "object",
      required: ["mission_id"],
      properties: {
        mission_id: { type: "string", description: "Mission id (must be on the board with status drafted/dispatched/ready)" },
        mode: {
          type: "string",
          enum: ["nested"],
          default: "nested",
          description:
            'Dispatch form (v1.6 W-p: the only value): "nested" (v1.2 M5-1 exit — no spawn; v1.6 W3a: returns the numbered receipt {mission_id, worker, channel, token, pack_path} for the coordinator to fill the fixed DP-3 pointer template). The former "headless" -p channel is parked at v1.6 W-p (archived: parked/agent-orchestrator/).',
        },
        pack_path: {
          type: "string",
          description: "Explicit pack path for non-standard pack locations (second priority after mission.pack.path)",
        },
        // v1.6 W-p: the headless-only supply/runner knob params and the v1.4 A1
        // bake-free persona param (OPEN-2 retirement) are removed — the headless
        // channel is parked. v1.6 W3a: the persona_path key is removed with the
        // assembly retirement (the persona resolution chain had no consumer left;
        // the role preset rides the subagent_type load — DP-3 template carries
        // only the bare role name).
      },
    },
  },
  {
    // v1.6 W-t: the 13th tool (appended last so the legacy 0.4.1 ten stay a prefix
    // and probe/dispatch keep their 11th/12th positions — zero drift for old readers).
    // Coordinator-only trajectory write face (design §2.2): replaces the retired
    // stop-check tail-block extraction (R7) as the writer of the coord-tail log.
    name: PREFIX + "trajectory",
    description:
      "Project memory trajectory writer (coordinator-only): appends one ORT v3 block to <storage-root>/context/coord-tail-log.md; " +
      "the server casts the protocol lines (ts = call time; seq = file max seq + 1, cross-session monotonic); " +
      "hysteresis 20/10 (the 21st block triggers one atomic rewrite keeping the newest 10); " +
      "cap validation errors on the spot (full <=10 lines/900B, short <=6 lines/400B); " +
      "the read face is unchanged (Read the tail, SKILL PL-10).\n\n" +
      "Usage:\n" +
      "- Call once per dispatch turn at close (PL-10 (1) close-of-turn call discipline): kind:\"full\" for change turns, kind:\"short\" for steady turns.\n" +
      "- full: project/stage/ruled/next required; flying optional - absent = auto-filled from board running/dispatched missions " +
      "(3 most recently updated; >3 in flight -> pass flying explicitly for the full picture; <=3 comma-separated items, no +/- prefixes).\n" +
      "- short: next required; project/stage/ruled inherit from the newest full block in the file (server-side merge, cross-session); " +
      "flying = +/-id deltas (\"-\" on an absent id is ignored).\n" +
      "- Receipt: {ok, seq, blocks, trimmed}. Over-cap or missing full baseline = isError (previously silent stderr + no write).",
    inputSchema: {
      type: "object",
      required: ["kind", "next"],
      properties: {
        kind: {
          enum: ["full", "short"],
          description: "full = change turn (all business fields); short = steady turn (only next, the rest inherit)",
        },
        project: { type: "string", description: "full only, required: one-sentence project status" },
        stage: { type: "string", description: "full only, required: current stage / wave" },
        flying: {
          type: "string",
          description:
            "full: whole table (<=3 comma-separated ids; absent = auto-fill from board running/dispatched). " +
            "short: +id/-id deltas (absent = no change)",
        },
        ruled: { type: "string", description: "full only, required: recent rulings FIFO (up to 3)" },
        next: { type: "string", description: "required (both kinds): one-sentence next intent" },
      },
    },
  },
];

export {
  TOOL_HANDLERS,
  TOOLS,
};
