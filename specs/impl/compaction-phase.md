# Impl: Compaction error-fix implementation phase

**Realises:** REQ-COMPACTION (`R-COMPACTION-001`, `R-COMPACTION-002`, `R-COMPACTION-003`, `R-COMPACTION-004`, `R-COMPACTION-005`, `R-COMPACTION-006`, `R-COMPACTION-007`, `R-COMPACTION-008`, `R-COMPACTION-009`, `R-COMPACTION-010`)
**Depends on phases:** —
**Verifies via:** `packages/coding-agent/test/suite/compaction-skip.test.ts`

## Work items (DAG)

| ID | Work item | Depends on | Realises | Verified by |
|---|---|---|---|---|
| W-01 | Add `CompactionSkipReason`, `CompactionPreparationOutcome`, `prepareCompactionOutcome()`, and `formatCompactionSkipReason()` in `packages/coding-agent/src/core/compaction/compaction.ts:907-964` while keeping `prepareCompaction()` as a compatibility wrapper | — | REQ-COMPACTION (`R-COMPACTION-001`, `R-COMPACTION-002`, `R-COMPACTION-003`) | `packages/coding-agent/test/suite/compaction-skip.test.ts` |
| W-02 | Extend `AgentSessionEvent` (`compaction_end` at `packages/coding-agent/src/core/agent-session.ts:192-201`) with `skipped?: boolean` and `skipReason?: CompactionSkipReason`; update `compact()` (`:2245`), `_runBackgroundCompaction()` (`:2480`), and `_runAutoCompaction()` (`:2843`) to consume `prepareCompactionOutcome()` and emit `skipped: true` without `errorMessage` or `session_compact_failed` | W-01 | REQ-COMPACTION (`R-COMPACTION-001`, `R-COMPACTION-006`, `R-COMPACTION-008`, `R-COMPACTION-009`, `R-COMPACTION-010`) | `packages/coding-agent/test/suite/compaction-skip.test.ts` |
| W-03 | Add pre-flight feasibility check and branch-leaf skip latch (`_thresholdCompactionSkipLeafId`) in `AgentSession._startThresholdBackgroundCompaction()` (`packages/coding-agent/src/core/agent-session.ts:2404-2415`), clearing the latch when the branch leaf advances or resets | W-01, W-02 | REQ-COMPACTION (`R-COMPACTION-004`, `R-COMPACTION-005`) | `packages/coding-agent/test/suite/compaction-skip.test.ts` |
| W-04 | Split `compaction_end` handling in `packages/coding-agent/src/modes/interactive/interactive-mode.ts:3624-3636` so `event.skipped` renders via `showStatus` / warning notice for manual triggers, stays quiet for threshold/background triggers, and never calls `showError` or `reportProviderError` | W-02 | REQ-COMPACTION (`R-COMPACTION-003`, `R-COMPACTION-006`, `R-COMPACTION-007`, `R-COMPACTION-008`, `R-COMPACTION-009`) | `packages/coding-agent/test/suite/compaction-skip.test.ts` |
| W-05 | Update extension `ctx.compact()` binding in `packages/coding-agent/src/core/agent-session.ts:3234-3249` and companion external extension `c:/dev/ai-compact-hot-swap/index.ts:436,464` (executed in the `fix-compaction` task) to pass `background: true` and treat skip outcomes as non-errors | W-02 | REQ-COMPACTION (`R-COMPACTION-010`) | `packages/coding-agent/test/suite/compaction-skip.test.ts` |

[ASSUMPTION: The branch-leaf ID returned by `this.sessionManager.getLeafId()` uniquely identifies whether any new entry has been appended or navigated to since a threshold skip — rationale: `SessionManager` assigns a fresh entry ID to every appended message, custom entry, or branch summary and updates the leaf pointer on tree navigation (`packages/coding-agent/src/core/agent-session.ts:2426,3006,3108`)]

## Verification strategy

- **Unit level (`prepareCompactionOutcome`):** Verify all four skip reasons (`"already_compacted"`, `"nothing_new_since_compaction"`, `"below_keep_recent_tokens"`, `"needs_migration"`) and their human-readable messages against synthetic `SessionEntry[]` branches in `packages/coding-agent/test/suite/compaction-skip.test.ts`.
- **Session integration level (`AgentSession` + faux provider):** Using `packages/coding-agent/test/suite/harness.ts` and the faux provider:
  1. Drive a session where `shouldCompact` is true (`contextTokens > contextWindow - reserveTokens`) but all post-compaction messages fit inside `keepRecentTokens`. Verify `_startThresholdBackgroundCompaction` latches on the leaf ID, does not emit `compaction_start` or `compaction_end` with `errorMessage`, and does not re-fire on a subsequent prompt until new messages exceed `keepRecentTokens`.
  2. Call `session.compactInBackground()` manually on an already-compacted branch and a small branch; verify `compaction_end` fires with `skipped: true`, `skipReason` populated, `errorMessage === undefined`, and `compactInBackground()` resolves `undefined`.
  3. Trigger a genuine provider error from the faux summariser stream; verify `compaction_end` fires with `skipped` falsy, `errorMessage` populated, and `session_compact_failed` emitted to extensions.
- **Typecheck & lint gate:** Run `bun run check` from repo root and run the targeted vitest suite via `node "$(git rev-parse --show-toplevel)/node_modules/vitest/dist/cli.js" --run test/suite/compaction-skip.test.ts` from `packages/coding-agent`.

## Rollback

- Revert commits touching `packages/coding-agent/src/core/compaction/compaction.ts`, `packages/coding-agent/src/core/agent-session.ts`, `packages/coding-agent/src/modes/interactive/interactive-mode.ts`, and `packages/coding-agent/test/suite/compaction-skip.test.ts`.
- Because `CompactionEntry` on-disk schema (`packages/coding-agent/src/core/session-manager.ts`) is unchanged by this phase, rolling back requires no session file migration.

## Out of scope

- **Summariser model selection (`compactionModel`):** Routing summarisation through a user-configured catalog model in `settings.json` (`_getSummarizationRequestAuth` at `packages/coding-agent/src/core/agent-session.ts:635-699`) is intentional uncommitted work already in the tree and must not be modified or reverted.
- **Compaction summary prompt and quality:** Changes to `SUMMARIZATION_PROMPT`, `UPDATE_SUMMARIZATION_PROMPT`, or chunk-splitting budgets in `packages/coding-agent/src/core/compaction/compaction.ts:539-890`.
- **Branch summarisation algorithm:** Tree-navigation summarisation in `packages/coding-agent/src/core/compaction/branch-summarization.ts`.

## Traceability

- **Realises:** `REQ-COMPACTION` (`R-COMPACTION-001` through `R-COMPACTION-010`)
- **Depends on ADRs:** `ADR-0005`
- **References:** `REQ-COMPACTION`, `ADR-0005`
