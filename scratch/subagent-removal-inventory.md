# Native subagent removal — inventory (ADR-0007)

Branch: `feat/remove-native-subagent` (worktree `C:\dev\worktrees_tmp\qi-remove-native-subagent`).
Baseline commit: `7582acd13` (fork/main).

## Subsystem tree (26 files, all deleted in Step 4)

`packages/coding-agent/src/core/subagent/`:
agents.ts, background.ts, bun-process-runner.ts, contact-supervisor-tool.ts,
control-watcher.ts, control.ts, experiment-registry.ts, experiment-tools.ts,
experiments-dashboard.ts, index.ts, orchestration.ts, render.ts, research-mode.ts,
result-record.ts, runtime.ts, saved-specs.ts, schema-validate.ts, session-lease.ts,
shell.ts, stream.ts, subagent-tool.ts, supervisor-channel.ts, types.ts,
win32-tree.ts, worktree-lock.ts, worktree.ts

Tests whose subject is the subsystem (deleted): `packages/coding-agent/test/subagent-*.test.ts`
(44 files), `test/analytics-subagent-spans.test.ts`, `test/suite/subagent-native.test.ts`,
`test/suite/regressions/8261-subagent-project-trust.test.ts`,
`test/print-mode-control-plane.test.ts`, plus `test/suite/agent-session-background-compaction.test.ts`
(background task registry replay) and `test/tool-factory-guards.test.ts` rows that only cover
subagent factory guards.

Docs deleted: `packages/coding-agent/docs/subagents.md`, `website/docs/fork/background-subagent.mdx`,
`website/docs/fork/experimental-mode.mdx`.

Docs retained with a "historical — subsystem removed" header (they document deleted code and
recommend changes to it, but nothing links to them as live guidance):
`docs/opencode-subagent-comparison.md`, `docs/claude-code-subagent-review.md`,
`docs/pi-subagents-review.md`, `docs/subagent-missing-features-plan.md`.

Specs: `specs/subagent/**`, `specs/00-requirements/features/subagents-requirements.md`,
`specs/impl/subagents-phase.md` deleted; `specs/adr/0004-native-subagent-self-sufficiency.md`
kept on disk and in the manifest with `status: "superseded"` (ADR-0007 depends on it).

## Q1 — symbols inside `core/subagent/` imported by code outside it

External (non-subagent) importers, all of them:

- `src/utils/shell.ts:5` imports `snapshotDescendants` from `core/subagent/win32-tree.ts`
  (win32 process-tree kill used by the generic bash tool). `win32-tree.ts` itself imports
  `getBun`/`isBunRuntime` from `runtime.ts` and `collectStream` from `stream.ts`, so those
  three modules must move together.
- `src/core/agent-session.ts:121,125-128,133-134` imports background registry, contact
  supervisor tool, experiment log path, `ResearchModeTracker`, result-record types,
  supervisor-channel helpers and `isFailedSubagentResult` — all removed, not relocated.
- `src/core/tools/index.ts:7,16,106,112` imports experiment-tool and subagent-tool
  factories — removed.
- `src/core/index.ts:110-205` re-exports the whole subagent barrel (`createStreamPump`,
  `collectStream`, `getBun`, `isBunRuntime`, `runShell`, …) — removed.
- `src/modes/interactive/interactive-mode.ts:111-128` imports background registry,
  experiment registry, dashboard render helpers and `listInlineSubagentRuns` — removed.
- `src/modes/print-mode.ts:13-16` imports background registry, control and supervisor
  helpers — removed.
- `src/index.ts:285-289` re-exports `SubagentEvent`, `SubagentRunner`, `SubagentSpec` —
  removed (public SDK break).
- `src/core/sdk.ts` imports `EXPERIMENT_TOOL_NAMES` via `core/tools/index.ts` — removed.

`parseFrontmatter` / `stripFrontmatter` live in `src/utils/frontmatter.ts` (not in the
subagent tree) and are kept (`prompt-templates.ts`, `skills.ts`, package root export).

## Q2 — tool registration

`src/core/tools/index.ts`:
- `ToolName` union includes `"subagent"` and `ExperimentToolName` (`:125-136`).
- `allToolNames` (`:137-147`) seeds `subagent` and `EXPERIMENT_TOOL_NAMES`.
- `ToolsOptions.subagent` (`:158`).
- `createToolDefinition` (`:166`) and `createTool` (`:203`) have `case "subagent"` and the
  eight `experiment_*` cases.
- `createCodingToolDefinitions` (`:250`), `createAllToolDefinitions` (`:287`),
  `createCodingTools` (`:323`), `createAllTools` (`:349`) push subagent/experiment tools
  when `shouldRegister*` passes.

`contact_supervisor` is registered outside the closed union, in
`src/core/agent-session.ts:3646-3653` (`_buildRuntime`), and added to the active set at
`:3689-3692`.

## Q3 — `Args.subagentDepth` / `--subagent-depth` consumers

- `src/cli/args.ts:56-62` (field + JSDoc), `:221-233` (`else if (arg === "--subagent-depth")`),
  `:481` (help line).
- `src/main.ts:1086-1087` passes `parsed.subagentDepth` into session creation.
- `src/core/agent-session-services.ts:65-66,222` forwards the option.
- `src/core/agent-session.ts:276-280` (`AgentSessionConfig.subagentDepth`), `:496-498`,
  `:537-538` (read once), `:3584` (parent-side depth guard).
- `src/core/sdk.ts:89-100` (`CreateAgentSessionOptions.subagentDepth`), `:307-313`
  (child-side depth guard removing `subagent` at max depth), `:452`.
- `packages/coding-agent/test/subagent-depth-guard.test.ts` (deleted with the subsystem).

## Q4 — public re-exports (breaking)

`packages/coding-agent/src/index.ts:285-289`:
```ts
export type { SubagentEvent, SubagentRunner, SubagentSpec } from "./core/subagent/index.ts";
```
Also `src/index.ts:20-24` exports `endSubagentTask`, `newTaskSpanId`, `startSubagentTask`
from `core/analytics-store.ts`; those functions serve only subagent spans and go with the
subsystem. No `exports` map entry points at subagent modules (package exports are `.`,
`./rpc-entry`, `./client` only). `src/core/index.ts` re-exports the subagent barrel but is
an internal barrel, not a package export.

## Q5 — `.qi/agents/` discovery

Only inside the subsystem: `src/core/subagent/agents.ts` (`AGENTS_DIR_NAME`,
`agentsDirs`, `listAgents`, `resolveAgent`, `parseAgentFile`) and its consumers
`src/core/subagent/subagent-tool.ts:70,906,917,2644`, plus the system-prompt usage text
(`src/core/system-prompt.ts:19`). No trust-manager, resource-loader, `/config` scope list
or `AGENTS_DIR_NAME` reference exists outside the subsystem. Deleting the tree removes it
all; Step 6.3 has no separate edit.

## Secondary surface found by the sweep (all subagent-specific)

- `core/system-prompt.ts:10-19,152-165` — `SUBAGENT_USAGE` + conditional section.
- `core/keybindings.ts:25-27,122-137` — three `app.subagent.*` bindings.
- `core/slash-commands.ts:41` — `/subagents` command.
- `core/analytics-store.ts` — `SubagentTaskRow`, `pi_subagent_tasks` table,
  `startSubagentTask`/`endSubagentTask`, pending map.
- `core/analytics-ext.ts:62` — comment only.
- `modes/interactive/interactive-mode.ts` — `/subagents` dashboard, experiments dashboard,
  status pills, `background_task_settled` handling, `app.subagent.*` wiring.
- `modes/print-mode.ts` — control-plane handoff, control watcher.
- `utils/shell.ts` — `trackDetachedChildPid`/`killTrackedDetachedChildren` are also used by
  the generic bash tool and rpc/interactive shutdown, so they stay; only the
  `snapshotDescendants` import path moves.

## Dependencies

Every `packages/coding-agent` dependency has a non-subagent consumer (grep evidence in the
final report): `proper-lockfile` (auth-storage, settings-manager, trust-manager),
`better-sqlite3` (analytics-store + session backends), `cross-spawn` (utils/child-process),
`diff`, `hosted-git-info`, `ignore`, `jiti`, `minimatch`, `semver`, `typebox`, `yaml`.
Step 10.2 therefore removes no dependency and does not touch the lockfile.