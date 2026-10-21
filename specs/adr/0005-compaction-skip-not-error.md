# ADR-0005: Compaction no-op is a typed skip, not a user-facing error

**Status:** draft
**Date:** 2026-10-20
**Domain:** compaction

## Context

`prepareCompaction()` (`packages/coding-agent/src/core/compaction/compaction.ts:907-964`) returns `undefined` across four distinct no-op conditions: the branch tip is already a compaction entry (`:910`), the cut-point entry lacks an ID (`:941`), or `messagesToSummarize` and `turnPrefixMessages` are both empty (`:962-964`) either because nothing new accumulated since the last compaction or because the entire branch fits within `keepRecentTokens` (default 20,000 at `settings-manager.ts:1024`, or `contextWindow * retainRatio` under DeepSeek Harness at `agent-session.ts:2240,2475`).

While `_runAutoCompaction()` (`packages/coding-agent/src/core/agent-session.ts:2843-2845`) silently returns `false` on `!preparation`, both `compact()` (`:2245-2252`) and `_runBackgroundCompaction()` (`:2480-2486`) throw `Error("Already compacted")` or `Error("Nothing to compact (session too small)")`. Those throws emit `compaction_end` with `errorMessage` (`:2367,:2572`), which `interactive-mode.ts:3624-3636` renders as a red error and sends to Sentry via `reportProviderError`. Furthermore, when `shouldCompact()` (`compaction.ts:249`) is true near the context limit while `prepareCompaction()` has `< keepRecentTokens` summarisable tokens, threshold checks (`agent-session.ts:520,775,2809`) re-fire on every prompt because `_backgroundCompaction` clears in `finally` (`:2581`). Extensions calling `ctx.compact()` (`agent-session.ts:3234`) such as `c:/dev/ai-compact-hot-swap/index.ts:436,464` receive the thrown error in `onError` and call `ctx.ui.notify(..., "error")` (`interactive-mode.ts:2800` -> `showError` `:4628`), producing repeated red `Error:` lines.

## Decision

We will introduce a typed skip result for compaction preparation (`CompactionSkipReason`: `"already_compacted" | "nothing_new_since_compaction" | "below_keep_recent_tokens" | "needs_migration"`), propagate skips through `compaction_end` (`skipped?: boolean`, `skipReason?: CompactionSkipReason`, no `errorMessage`), pre-check and latch threshold skips until the branch leaf changes, and render skips as status/warning notices without invoking `showError` or `reportProviderError`.

[ASSUMPTION: `prepareCompaction()` remains backwards-compatible by returning `CompactionPreparation | undefined` while a companion `prepareCompactionOutcome()` returns `{ status: "ready", preparation } | { status: "skip", reason, message }` — rationale: `prepareCompaction` is part of the public SDK surface documented in `packages/coding-agent/docs/compaction.md:208` and tested directly across existing compaction tests]
[UNRESOLVED: Should blocking `AgentSession.compact()` still reject with a `CompactionSkippedError` for direct RPC/SDK callers expecting a `CompactionResult`, or resolve? — suggested: Have `compactInBackground()` resolve `undefined` on skip (matching its `Promise<CompactionResult | undefined>` signature at `agent-session.ts:2389`) while blocking `compact()` rejects with a typed `CompactionSkippedError` after emitting `compaction_end` with `skipped: true` and `errorMessage: undefined`]

## Consequences

**Positive:**
- Eliminates repeated red TUI errors when context is above `shouldCompact` but summarisable tokens are below `keepRecentTokens`.
- Distinguishes `"nothing_new_since_compaction"` from `"below_keep_recent_tokens"`, removing the misleading `"session too small"` message on large sessions.
- Stops polluting Sentry (`reportProviderError`) with benign compaction no-ops.
- Pre-check and branch-leaf latch prevent redundant background compaction launches on every turn/prompt.

**Negative:**
- Adds `skipped` and `skipReason` fields to `compaction_end` in `AgentSessionEvent` (`agent-session.ts:192-201`), requiring event consumers to check `event.skipped` alongside `event.errorMessage`.

**Neutral:**
- Genuine summariser provider errors and exhausted overflow retries continue to populate `errorMessage`, call `showError`, and report to telemetry.

## Alternatives considered

- **Keep throwing and downgrade at the UI only:** Rejected because `_startThresholdBackgroundCompaction` would still re-fire every prompt, `reportProviderError` and extension `onError` would still need brittle string-matching on error messages, and `compaction_start` would still fire unnecessarily.
- **Pre-filter at each trigger without a typed result:** Rejected because manual `/compact` and extension `ctx.compact()` still execute when there is nothing to summarise and need an accurate, typed skip reason to display to the user.
- **Disable automatic compaction:** Rejected because automatic background compaction is required to keep long sessions within model context windows before hitting hard overflow errors.

## Compliance checklist

- [ ] `compaction.ts` exports `CompactionSkipReason` and `prepareCompactionOutcome()` distinguishing `"already_compacted"`, `"nothing_new_since_compaction"`, `"below_keep_recent_tokens"`, and `"needs_migration"`.
- [ ] `AgentSession` emits `compaction_end` with `skipped: true` and `errorMessage: undefined` when compaction skips in `compact()` or `_runBackgroundCompaction()`.
- [ ] `_startThresholdBackgroundCompaction()` pre-checks preparation feasibility and latches skips until the branch leaf ID changes.
- [ ] `interactive-mode.ts` handles `compaction_end` with `skipped: true` via status/warning notification, never calling `showError` or `reportProviderError`.
- [ ] Automated test in `packages/coding-agent/test/suite/` verifies threshold compaction does not re-fire or emit `errorMessage` when `shouldCompact` is true but summarisable tokens are below `keepRecentTokens`.

## Traceability

- **Realises:** `REQ-COMPACTION` (`R-COMPACTION-001` through `R-COMPACTION-010`)
- **Depends on ADRs:** None
- **Referenced by:** `REQ-COMPACTION`, `IMPL-COMPACTION`
