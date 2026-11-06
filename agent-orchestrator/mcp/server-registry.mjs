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
      "- The data source for cross-session resume; action semantics on the `action` parameter, behavior contract in SKILL section 14 (TS-1/2/11).\n" +
      "- upsert shallow-merges `mission` fields (dispatch/blocked/pack one level deeper); list excludes closed missions by default.\n" +
      "- upsert/ack return {ok,id,status}; get omits timeline/original_prompt - pass view:\"full\" for the verbatim record.\n" +
      "- p2p_ask only from a blocked/question mission (server-arbitrated peer Q&A; TS-11).\n" +
      "- Do NOT pass the read-only fields owner/claim/ack in `mission` - they are ignored.",
    inputSchema: {
      type: "object",
      properties: {
        action: {
          enum: ["upsert", "get", "list", "ack", "claim", "p2p_ask", "p2p_answer"],
          description:
            "upsert=create/merge; get=fetch; list=list (closed excluded); ack=acknowledge; claim=pool CAS claim; p2p_ask/p2p_answer=peer Q&A (SKILL section 14)",
        },
        to_mission_id: {
          type: "string",
          description: "p2p_ask target mission id (the answering side; must exist and be non-terminal)",
        },
        to_worker: {
          type: "string",
          description: "p2p_ask answering worker (mission holder)",
        },
        question: {
          type: "string",
          description: "p2p_ask question body (truncated at 4000 chars)",
        },
        p2p_id: {
          type: "string",
          description: "p2p_answer target record id (from the p2p_ask response; open records only)",
        },
        answer: {
          type: "string",
          description: "p2p_answer body (truncated at 4000 chars; advisory data)",
        },
        // v1.1.1 W20 DP hotfix: p2p_ask/p2p_answer read args.token for the
        // report-gate mirror (p2pTokenGate), but the schema never declared it —
        // schema-validating MCP clients strip undeclared arguments, so every
        // subagent p2p call arrived token-less and was refused. Declaring it here
        // is the whole fix: the handler face is unchanged.
        token: {
          type: "string",
          description: "worker dispatch token (pack CONTRACT [token] line); p2p auth when the mission carries one",
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
                "upstream mission_id list (DAG): unlocks when all upstream done/skipped/closed; failed/skipped cascades skipped; cycles rejected",
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
                  description: "coordinator session id that issued the spawn (W9 scoping ownership face; null = anchor absent)",
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
      "- Call at each verifiable unit and once at the end; artifacts paths on done.\n" +
      "- Event protocol = the dispatch pack's CONTRACT section (SKILL section 14 TS-12).\n" +
      "- summary caps at 200 characters; long findings go in details.\n" +
      "- question is required for kind=blocked/question.\n" +
      "- lessons and manifest_entries are done-only.",
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
      "answer logs a reply, gc archives old events (SKILL section 5).\n\n" +
      "Usage:\n" +
      "- read takes over subagent results (wake-up handover); peek surveys only.\n" +
      "- kind and mission_id narrow the listing; limit caps results.\n" +
      "- answer logs the coordinator reply and returns the recommended SendMessage call (never messages the worker directly).\n" +
      "- gc removes events older than keep_days (default 14).",
    inputSchema: {
      type: "object",
      properties: {
        action: { enum: ["peek", "read", "answer", "gc"] },
        mission_id: { type: "string" },
        kind: { enum: ["milestone", "blocked", "question", "done"] },
        limit: { type: "number", default: 20 },
        answer: { type: "string", description: "Required for action=answer" },
        keep_days: { type: "number", default: 14, description: "gc threshold in days" },
      },
    },
  },
  {
    name: PREFIX + "spawn_agent",
    description:
      "Create a custom subagent persona at <project>/.zcode/agents/<name>.md from an archetype template; it registers in new sessions (SKILL section 8).\n\n" +
      "Usage:\n" +
      "- To use it in-session, dispatch a general-purpose agent with the file body as the prompt.\n" +
      "- tools overrides the archetype toolset and MUST keep the report tool's full name.\n" +
      "- system_prompt is appended after the archetype body.\n" +
      "- model defaults to the session model.",
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
          description: "overrides the archetype toolset",
        },
        system_prompt: { type: "string", description: "appended after the archetype body" },
        overwrite: { type: "boolean", default: false },
      },
    },
  },
  {
    name: PREFIX + "context_pack",
    description:
      "Materialize a context pack (1-8 variants) and return the dispatch header and token; pack rules in SKILL section 14 (TS-3).\n\n" +
      "Usage:\n" +
      "- Copy upstream context verbatim; the subagent was absent.\n" +
      "- inputs freeze at pack time; later upstream updates do not propagate.\n" +
      "- scope_paths = sandbox write allowlist; isolation=worktree creates the sandbox.",
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
          description: "worktree = git worktree sandbox; none = in-repo (default from userConfig)",
        },
        oob_allowlist: {
          type: "array",
          items: { type: "string" },
          description: "legacy alias of scope_paths (repo-relative prefixes; empty = all paths)",
        },
        scope_paths: {
          type: "array",
          items: { type: "string" },
          description: "write allowlist, max 32 (SKILL section 14 TS-3)",
        },
        budget: {
          enum: ["S", "M", "L"],
          description: "S/M/L step budget (TS-3)",
        },
        inputs: {
          type: "array",
          items: { type: "string" },
          description: "upstream mission ids, max 4 (TS-3)",
        },
        share_node_modules: {
          type: "boolean",
          description: "Auto-share node_modules via junction (SKILL section 12)",
        },
        extra: {
          type: "string",
          description: "coordinator note; appended verbatim as EXTRA",
        },
        worker_name: {
          type: "string",
          description: "worker name for the pack header",
        },
        persona_path: {
          type: "string",
          description: "register the persona file for dispatch (mission.pack.persona); absent = no byte change",
        },
        mirror_digest: {
          type: "boolean",
          default: false,
          description: "true = append a recent-context digest",
        },
      },
    },
  },
  {
    name: PREFIX + "resume",
    description:
      "Resume briefing: per unclosed mission a recommended_action (same-session chat / workflow resume / cross-session re-dispatch; SKILL section 5 CL-9).\n\n" +
      "Usage:\n" +
      "- Call once at session start.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: {
          type: "string",
          description: "current session id (separates same-session advice)",
        },
      },
    },
  },
  {
    name: PREFIX + "lessons",
    description:
      "Orchestration lessons memory: list/add/promote/promote_batch/retire/stage (contract in SKILL section 10).\n\n" +
      "Usage:\n" +
      "- promote: refine a candidate to active; same trigger+fix auto-merges hits/confidence. " +
      "Global: target=\"global\" promotes fleet-wide (merge or create scope=global; refs=[source id, source project path, root_id] backlink; source entry untouched).\n" +
      "- promote_batch: transactional batch promote, single promote semantics per item; invalid item rejects the batch (SKILL section 10 TS-7).\n" +
      "- stage: Coordinator-side staging (ORCHTEMP): writes source=\"orchestrator\"/candidate/confidence=0; no merge no injection; consumed by the gleaner (retired+view-layer write-back). trigger/fix required.\n" +
      "- add: coordinator-direct insert.\n" +
      "- retire: manual retirement with a reason.\n" +
      "- list with token: per-reader hash baseline (no-new -> short answer); ANY write carrying a token is rejected (worker read-only gate).",
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
            "list-only hash-read reader key (worker=dispatch token / coordinator=coord-session id); token-bearing writes rejected (worker read-only gate)",
        },
        id: { type: "string", description: "promote/retire target entry id (l-...)" },
        ids: {
          type: "array",
          description: "promote_batch ids; all-or-nothing",
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
          description: "list filter: active|candidate|superseded|retired|all",
        },
        type: {
          enum: ["error-fix", "pitfall", "preference", "env-fact"],
          description: "required for add; optional list filter",
        },
        q: {
          type: "string",
          description: "list keyword filter (trigger/lesson/fix substring)",
        },
        trigger: { type: "string", maxLength: 120, description: "required for add/stage; promote refinement" },
        lesson: { type: "string", maxLength: 200, description: "optional one-line lesson" },
        fix: { type: "string", maxLength: 200, description: "required for add/stage; promote refinement" },
        mission_id: {
          type: "string",
          description: "optional add/stage source mission (refs/counter_refs)",
        },
        contradicts: {
          type: "string",
          description: "add-only: id this entry disproves (superseded + counter-example)",
        },
        target: {
          enum: ["project", "global"],
          description: "promote target; default project, global=fleet-wide (standard in SKILL section 10)",
        },
        note: {
          type: "string",
          maxLength: 200,
          description: 'stage placement hint, e.g. "pin: AGENTS.md" (consumed by the gleaner)',
        },
        reason: { type: "string", maxLength: 200, description: "retire note" },
        limit: { type: "number", default: 8, description: "list return cap (default 8)" },
      },
    },
  },
  {
    name: PREFIX + "sandbox_apply",
    description:
      "Sandbox finalize (gate tool): merge the sandbox branch back into the main repo and remove the worktree; gate = done + qa.verdict=pass (SKILL section 12).\n\n" +
      "Usage:\n" +
      "- Flow: status survey, out-of-scope detection, merge-tree pre-check, clean merge+commit, worktree removal, board closed with auto-ack.\n" +
      "- On conflict: isError with the conflict list; main repo untouched.\n" +
      "- allow_dirty = escape hatch for uncommitted main-repo changes; the qa gate cannot be bypassed.",
    inputSchema: {
      type: "object",
      required: ["mission_id"],
      properties: {
        mission_id: { type: "string" },
        allow_dirty: {
          type: "boolean",
          default: false,
          description: "true = proceed when the main repo has uncommitted changes; the qa gate still applies",
        },
      },
    },
  },
  {
    name: PREFIX + "sandbox_discard",
    description:
      "Discard a sandbox: delete the sandbox branch and worktree, zero main-repo changes; status untouched (SKILL section 12).\n\n" +
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
      "Read-only harvest of a subagent rollout transcript tail, rendered as role-labeled text (SKILL section 14 TS-9).\n\n" +
      "Usage:\n" +
      "- Locate by any one of mission_id, agent_id, or session_id.\n" +
      "- The tail = the conversation embedded in the last model-io record; works across sessions; terminal deliverables still follow report artifacts.\n" +
      "- tail=0 is probe mode: no transcript echo, only usage/file_bytes/messages_kind metadata.",
    inputSchema: {
      type: "object",
      properties: {
        mission_id: {
          type: "string",
          description: "harvest by mission (resolves dispatch.agent_id); one locator suffices",
        },
        agent_id: { type: "string", description: "agent_<uuid> (sess_subagent_agent_ prefix added automatically)" },
        session_id: { type: "string", description: "full session id (sess_...)" },
        tail: {
          type: "number",
          default: 12,
          description: "trailing messages to render (1-100, default 12); 0 = probe mode",
        },
        max_chars: {
          type: "number",
          default: 8000,
          description: "transcript char cap (200-48000, default 8000)",
        },
        include_tools: {
          type: "boolean",
          default: true,
          description: "render assistant tool-call lines (default true)",
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
      "- Every ok response is a summary JSON envelope, never a raw dump.\n" +
      "- db.query: restricted read-only SQL (single SELECT/WITH; bare SELECT * banned except COUNT(*); LIMIT <= 100).\n" +
      "- file.head: first/last <= 50 lines (tail=true; log-tail semantics, terminal).\n" +
      "- file.grep: grep -m semantics; max_count <= 50; ignore_case available.\n" +
      "- bin.inspect: type/size/sha256/first 256 bytes only.\n" +
      "- Session read cache: identical repeats return a stub; no_cache=true forces a full re-read.\n" +
      "- Paths may be any readable file - caps, not sandbox scope.",
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
          description: "target path (absolute or project-relative); SQLite file for db.query",
        },
        query: {
          type: "string",
          description: "read-only SQL: single SELECT/WITH, no INTO/comments/multi-statements; LIMIT <= 100",
        },
        lines: {
          type: "number",
          description: "file.head row count (1-50, default 50)",
        },
        tail: {
          type: "boolean",
          description: "file.head: true = last <= 50 lines (terminal, no page_token)",
        },
        pattern: {
          type: "string",
          description: "JS regex for file.grep (<= 500 chars)",
        },
        max_count: {
          type: "number",
          description: "file.grep max rows (1-50, default 50)",
        },
        ignore_case: {
          type: "boolean",
          description: "case-insensitive matching (grep -i)",
        },
        page_token: {
          type: "string",
          description: "pass back the previous page_token verbatim; bound to action+file",
        },
        no_cache: {
          type: "boolean",
          description: "true = skip the session read cache (result not cached)",
        },
      },
    },
  },
  {
    // v1.1.1 W20: the 12th tool (appended last so the legacy 0.4.1 ten stay a
    // prefix and probe keeps its 11th position — zero drift for old readers).
    name: PREFIX + "dispatch",
    description:
      "Dispatch launcher: mints the dispatch credential set (numbered receipt), single nested form; history in SKILL section 14 TS-19a.\n\n" +
      "Usage:\n" +
      "- Coordinator-only; surface = board upsert -> context_pack -> dispatch(mission_id).\n" +
      "- Pack resolves mission.pack.path -> <root>/packs/<mission_id>/pack.md.\n" +
      "- Fill the DP-3 pointer template (SKILL section 2-3) with the receipt fields verbatim - zero assembly, no expansion, no CONTRACT rewrites.\n" +
      "- mode=nested: no spawn; agent_id stays null (sentinel does not watch nested missions).\n" +
      "- Embedded checks: CONTRACT token = mission.dispatch.token + the yolo scope_paths gate (scout/reviewer exempt).\n" +
      "- Busy gate: a second dispatch while the worker result pends is rejected; recovery = board upsert status:\"drafted\".\n" +
      "- Returns {ok, mode, mission_id, worker, channel, token, pack_path, lock_hold_ms}; completion = host Agent return + worker report.",
    inputSchema: {
      type: "object",
      required: ["mission_id"],
      properties: {
        mission_id: { type: "string", description: "Mission id (must be on the board with status drafted/dispatched/ready)" },
        mode: {
          type: "string",
          enum: ["nested"],
          default: "nested",
          description: 'Dispatch form: "nested" (only value, default; no spawn)',
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
      "Trajectory writer (coordinator-only): appends one ORT v3 block to <storage-root>/context/coord-tail-log.md (SKILL section 16 PL-10).\n\n" +
      "Usage:\n" +
      "- Call once per dispatch turn at close (PL-10): full = change turn, short = steady turn.\n" +
      "- full: project/stage/ruled/next required; flying absent = auto-filled from board.\n" +
      "- short: next required; rest inherit from the newest full block (server merge); flying = +/-id deltas.\n" +
      "- Server casts protocol lines (ts/seq); caps 10 lines/900B full, 6/400B short; hysteresis 20/10 (TS-20).\n" +
      "- Read face unchanged; receipt {ok, seq, blocks, trimmed}; over-cap/missing baseline = isError.",
    inputSchema: {
      type: "object",
      required: ["kind", "next"],
      properties: {
        kind: {
          enum: ["full", "short"],
          description: "full = change turn; short = steady turn (rest inherit)",
        },
        project: { type: "string", description: "full only: one-sentence project status" },
        stage: { type: "string", description: "full only: current stage / wave" },
        flying: {
          type: "string",
          description: "full: <=3 comma-separated ids; short: +id/-id deltas",
        },
        ruled: { type: "string", description: "full only: recent rulings FIFO (up to 3)" },
        next: { type: "string", description: "both kinds: one-sentence next intent" },
      },
    },
  },
];

export {
  TOOL_HANDLERS,
  TOOLS,
};
