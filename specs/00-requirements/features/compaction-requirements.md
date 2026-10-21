# Compaction Requirements

## Scope

This specification governs how context compaction in `qi` classifies, surfaces, latches, and reports no-op compaction attempts versus genuine compaction failures across manual, threshold-triggered, overflow-recovery, and extension-initiated compaction flows. It does not govern summariser model selection, summary prompt wording, or branch navigation summarisation.

## Requirements

### R-COMPACTION-001: Typed skip outcome for no-op compaction preparation

**Priority:** MUST
**Statement:** The system represents a compaction preparation attempt that finds nothing eligible to summarise as a structured skip outcome rather than throwing an exception.
**Rationale:** Currently `prepareCompaction` (`packages/coding-agent/src/core/compaction/compaction.ts:907-964`) returns bare `undefined`, causing `AgentSession.compact()` (`packages/coding-agent/src/core/agent-session.ts:2245-2252`) and `AgentSession._runBackgroundCompaction()` (`packages/coding-agent/src/core/agent-session.ts:2480-2486`) to throw `Error("Already compacted")` or `Error("Nothing to compact (session too small)")`. Those exceptions propagate into `compaction_end` with `errorMessage: "Compaction failed: ..."` (`agent-session.ts:2367,2572`) and into extension `onError` callbacks (`agent-session.ts:3246`), surfacing benign no-ops as red error banners (`packages/coding-agent/src/modes/interactive/interactive-mode.ts:2800,3624-3636,4628`).
**Acceptance criteria:**
- AC1: Given a session branch where compaction preparation finds no eligible messages to summarise, when compaction preparation runs, then it returns a structured skip outcome identifying why compaction cannot proceed without throwing.
- AC2: Given a compaction run that terminates due to a skip outcome, when the session emits the terminal compaction completion event, then the event marks `skipped: true` with the structured skip reason and leaves `errorMessage` undefined.
**Source:** `specs/batch/batch-context.md` §3.4; `ADR-0005`

### R-COMPACTION-002: Distinct skip reasons for compaction preparation

**Priority:** MUST
**Statement:** The system distinguishes between a branch whose latest entry is already a compaction checkpoint, a branch with no new summarisable messages since the previous compaction checkpoint, a branch whose total history is within the recent-token retention budget, and a branch lacking valid entry identifiers.
**Rationale:** `prepareCompaction` (`packages/coding-agent/src/core/compaction/compaction.ts:907-964`) collapses four different early-return branches (`:910` latest entry is `"compaction"`, `:941` missing `firstKeptEntry.id`, `:962-964` empty `messagesToSummarize` and `turnPrefixMessages` with a prior compaction vs without a prior compaction) into `undefined`. Callers at `agent-session.ts:2245-2252` and `:2480-2486` only re-check whether the last entry is `"compaction"` and misclassify every other case as `"Nothing to compact (session too small)"`.
**Acceptance criteria:**
- AC1: Given a branch whose tip entry has type `"compaction"` or is empty, when compaction preparation evaluates the branch, then the skip reason is `"already_compacted"`.
- AC2: Given a branch that contains a prior compaction entry and whose subsequent entries do not exceed the kept recent-token budget, when compaction preparation evaluates the branch, then the skip reason is `"nothing_new_since_compaction"`.
- AC3: Given a branch with no prior compaction entry whose total message tokens do not exceed the kept recent-token budget, when compaction preparation evaluates the branch, then the skip reason is `"below_keep_recent_tokens"`.
- AC4: Given a branch whose computed cut-point entry lacks an entry identifier, when compaction preparation evaluates the branch, then the skip reason is `"needs_migration"`.
**Source:** `specs/batch/batch-context.md` §3.4; `ADR-0005`

### R-COMPACTION-003: Accurate user-facing skip descriptions

**Priority:** MUST
**Statement:** The system describes each compaction skip using wording that matches the specific skip reason without labelling a previously compacted or high-retention session as too small.
**Rationale:** When `keepRecentTokens` is 20,000 (`packages/coding-agent/src/core/settings-manager.ts:1024`) or raised to `Math.floor(contextWindow * retainRatio)` by the DeepSeek Harness (`packages/coding-agent/src/core/agent-session.ts:2239-2241,2474-2476`), a large session that recently compacted or has a large kept tail hits `messagesToSummarize.length === 0` at `compaction.ts:962`. Labelling that state `"Nothing to compact (session too small)"` (`agent-session.ts:2251,2485`) misleads users into thinking their context is tiny when it is actually near the context window limit.
**Acceptance criteria:**
- AC1: Given a skip reason of `"nothing_new_since_compaction"`, when the system formats a human-readable skip message, then the message states that there are no new messages eligible to summarise beyond the kept recent window since the last compaction.
- AC2: Given a skip reason of `"below_keep_recent_tokens"`, when the system formats a human-readable skip message, then the message states that the conversation fits within the recent-token retention budget.
- AC3: Given a skip reason of `"already_compacted"`, when the system formats a human-readable skip message, then the message states that the session is already compacted at the current branch tip.
**Source:** `specs/batch/batch-context.md` §3.4

### R-COMPACTION-004: Pre-flight feasibility check before threshold background compaction

**Priority:** MUST
**Statement:** The system verifies that compaction preparation can produce a non-empty summarisation span before starting a threshold-triggered background compaction.
**Rationale:** `shouldCompact` (`packages/coding-agent/src/core/compaction/compaction.ts:249-252`) checks only `contextTokens > contextWindow - reserveTokens`, while `prepareCompaction` (`compaction.ts:907-964`) requires messages outside `keepRecentTokens`. When `shouldCompact` is true but `prepareCompaction` cannot cut any messages, `_startThresholdBackgroundCompaction` (`packages/coding-agent/src/core/agent-session.ts:2404-2415`) still emits `compaction_start`, resolves auth, and enters `_runBackgroundCompaction` (`:2436`) only to fail immediately at `:2480`.
**Acceptance criteria:**
- AC1: Given `shouldCompact` evaluates to true at a turn boundary or post-run check, when compaction preparation for the current branch returns a skip outcome, then `_startThresholdBackgroundCompaction` does not launch a background compaction task or emit `compaction_start`.
- AC2: Given `shouldCompact` evaluates to true and compaction preparation returns a valid preparation payload, when `_startThresholdBackgroundCompaction` runs, then background compaction starts normally.
**Source:** `specs/batch/batch-context.md` §3.4

### R-COMPACTION-005: Branch-growth latch for skipped threshold compaction

**Priority:** MUST
**Statement:** The system latches a skipped threshold compaction state against the current branch leaf and suppresses further threshold compaction attempts until a new entry is appended or the active branch leaf changes.
**Rationale:** Threshold checks fire pre-prompt (`packages/coding-agent/src/core/agent-session.ts:769-777`), between turns (`:512-533`), and post-run (`:2809-2812`). Because `_backgroundCompaction` is cleared in `finally` (`:2581`), a session where `shouldCompact` is true but `prepareCompaction` skips will re-evaluate on every turn and prompt unless latched until branch state changes.
**Acceptance criteria:**
- AC1: Given a threshold check that resulted in a compaction skip at branch leaf `L`, when another threshold check runs while the branch leaf is still `L`, then the system skips compaction evaluation without re-running preparation or emitting events.
- AC2: Given a latched threshold skip at branch leaf `L`, when a new message entry is appended or the session navigates to a different branch leaf `L2`, then the latch clears and the next threshold check evaluates normally.
**Source:** `specs/batch/batch-context.md` §3.4

### R-COMPACTION-006: Non-error status rendering for automatic and background skips

**Priority:** MUST
**Statement:** The system renders skipped automatic or background compactions as transient or silent informational status rather than error notifications.
**Rationale:** `_runAutoCompaction` (`packages/coding-agent/src/core/agent-session.ts:2843-2845`) already returns `false` silently when `!preparation`, whereas `_runBackgroundCompaction` (`:2480-2486`) throws and emits `compaction_end` with `errorMessage`, which `interactive-mode.ts:3624-3636` renders as red error text.
**Acceptance criteria:**
- AC1: Given a threshold-triggered compaction that skips, when the interactive session processes the outcome, then no red error banner or error line is appended to the transcript.
- AC2: Given a background compaction that is superseded or skipped after launch, when `compaction_end` fires with `skipped: true`, then the interactive session updates status without calling the error display channel.
**Source:** `specs/batch/batch-context.md` §3.4

### R-COMPACTION-007: Non-error notice for manual compaction skips

**Priority:** MUST
**Statement:** The system surfaces a manual compaction skip to the user as an informational or warning notice explaining the skip reason without styling it as a failure.
**Rationale:** When a user invokes `/compact` (`packages/coding-agent/src/modes/interactive/interactive-mode.ts`) on a branch with nothing eligible to summarise, they need feedback explaining why no summary was written, but routing through `showError` (`interactive-mode.ts:3624-3636,4628`) falsely signals a system fault.
**Acceptance criteria:**
- AC1: Given a user-initiated manual compaction on a branch where preparation skips, when `compaction_end` fires with `reason: "manual"` and `skipped: true`, then the interactive session displays the human-readable skip reason via the status or warning notification channel and does not call `showError`.
- AC2: Given a user-initiated manual compaction that skips, when `compaction_end` completes, then the session remains idle and ready for input without requiring recovery.
**Source:** `specs/batch/batch-context.md` §3.4; `ADR-0005`

### R-COMPACTION-008: Preservation of error reporting for genuine compaction failures

**Priority:** MUST
**Statement:** The system reports genuine compaction failures caused by summarisation request errors, invalid model configuration, or exhausted overflow recovery attempts through the error notification channel and failure events.
**Rationale:** Converting no-op skips to non-errors must not mask real provider failures (such as network drops after retries, authentication errors in `_getSummarizationRequestAuth` at `packages/coding-agent/src/core/agent-session.ts:635`, or truncated summary responses at `packages/coding-agent/src/core/compaction/compaction.ts:619-626`).
**Acceptance criteria:**
- AC1: Given a compaction attempt where the summarisation request fails after configured retries, when `compaction_end` fires, then `skipped` is not set, `errorMessage` contains the failure description, `session_compact_failed` is emitted to extensions, and the interactive session displays the error.
- AC2: Given an overflow recovery compaction that exhausts `maxOverflowRetries` (`packages/coding-agent/src/core/agent-session.ts:2695-2709`), when `compaction_end` fires, then it is treated as a genuine failure and displayed via the error channel.
**Source:** `specs/batch/batch-context.md` §3.4

### R-COMPACTION-009: Exclusion of compaction skips from error telemetry

**Priority:** MUST
**Statement:** The system excludes skipped compactions from provider error telemetry reporting and extension failure telemetry events.
**Rationale:** `interactive-mode.ts:3624-3636` invokes `reportProviderError` whenever `compaction_end` carries `errorMessage`, sending benign `"Already compacted"` and `"Nothing to compact"` skips to error telemetry. Similarly, `session_compact_failed` (`packages/coding-agent/docs/compaction.md:402-415`) is intended for failed or aborted compactions, not no-op skips.
**Acceptance criteria:**
- AC1: Given a compaction that terminates with `skipped: true`, when `compaction_end` is handled in interactive mode, then `reportProviderError` is not called.
- AC2: Given a compaction that terminates with `skipped: true`, when `AgentSession` finishes handling the skip, then `session_compact_failed` is not emitted.
**Source:** `specs/batch/batch-context.md` §3.4; `ADR-0005`

### R-COMPACTION-010: Non-blocking extension compaction and skip propagation

**Priority:** MUST
**Statement:** The system allows extensions to trigger background compaction and delivers skip outcomes without invoking error-level failure notifications.
**Rationale:** Extension `ctx.compact()` (`packages/coding-agent/src/core/agent-session.ts:3234-3249`) runs blocking `this.compact()` unless `options?.background` is true, and routes any thrown skip from `compact()` or `compactInBackground()` into `options?.onError`. In the external extension `c:/dev/ai-compact-hot-swap/index.ts:436,464`, calling `ctx.compact({ onComplete, onError })` without `background: true` and forwarding `onError` to `ctx.ui.notify(..., "error")` (`interactive-mode.ts:2800` -> `showError` `:4628`) produced the repeated red `Error:` lines in the user's screenshot.
[ASSUMPTION: `ctx.compact` resolves skips without invoking `options.onError` when `background: true` is used, while external extension callers also guard `onError` for skip messages — rationale: `agent-session.ts:3240-3243` already treats `undefined` return from `compactInBackground` as a non-error no-op that skips `onComplete` and `onError`]
**Acceptance criteria:**
- AC1: Given an extension calling `ctx.compact({ background: true, onComplete, onError })` when compaction preparation skips, when `compactInBackground` resolves `undefined`, then `onError` is not called.
- AC2: Given the hot-swap compaction extension invoking `ctx.compact`, when it requests compaction, then it passes `background: true` and surfaces any skip message at informational or warning severity rather than error severity.
**Source:** `specs/batch/batch-context.md` §3.4

## Traceability

- **Realises:** `REQ-COMPACTION`
- **Depends on ADRs:** `ADR-0005`
- **Referenced by:** `IMPL-COMPACTION`
