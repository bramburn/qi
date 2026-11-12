# ADR-0007: Remove the native subagent subsystem

**Status:** accepted
**Date:** 2026-10-26
**Domain:** subagents
**Supersedes:** [ADR-0004](0004-native-subagent-self-sufficiency.md)

## Context

ADR-0004 made `packages/coding-agent/src/core/subagent/` the only subagent implementation in `qi` and removed the external `pi-subagents` guidance and the bundled example extension. The subsystem then grew to 26 source files and ~45 test files: an out-of-process runner, a durable background registry, a SQLite experiment registry, a control-plane inbox, a supervisor channel, a worktree lease/lock layer, two TUI dashboards, and eight `experiment_*` tools.

Operating that surface costs more than it returns:

1. It duplicates capability that extensions already provide through `registerTool` and `exec`. The removed `examples/extensions/subagent/` was itself a working implementation, and the extension API is the supported extension point.
2. Every internal seam (registry hygiene on startup, depth propagation on `--subagent-depth`, contact-supervisor registration, collision guards in `refreshToolRegistry`, background settle replay) leaks into `AgentSession`, the settings type, the CLI parser, the system prompt, the keybinding table, and the package root exports. Removing one subagent concern therefore required editing a dozen unrelated modules.
3. The depth guard exists only because the subsystem spawns itself: bounding a tree of self-spawned processes is not a problem an extension can create for the core loop, and it is the one place a settings value crosses the process boundary on argv.
4. The feature was never released as a stable contract. Shipping it in `[Unreleased]` and then hard-removing it avoids carrying a public API that no user has depended on.

## Decision

Remove the native subagent subsystem completely, with no shim and no deprecation period.

- Delete `packages/coding-agent/src/core/subagent/**`, the `subagent` / `contact_supervisor` / `experiment_*` tools, `/subagents`, the background-task and experiments dashboards, the `app.subagent.*` keybindings, the `background_task_settled` event, and every `subagent.*` setting.
- Delete `--subagent-depth` from the CLI parser and `subagentDepth` from `CreateAgentSessionOptions`.
- Delete the package-root exports `SubagentEvent`, `SubagentRunner`, `SubagentSpec`, and the subagent-only analytics helpers.
- Keep the three helpers that had a live non-subagent consumer, moved out of the deleted directory: `snapshotDescendants` (`src/utils/win32-tree.ts`, used by generic bash teardown), plus its `runtime.ts` and `subprocess-stream.ts` dependencies.
- Delete `packages/coding-agent/docs/subagents.md`, `examples/extensions/subagent/`, `website/docs/fork/background-subagent.mdx`, and `specs/subagent/**`.
- Ignore a legacy `subagent` key left in `settings.json`; do not migrate it implicitly. `scripts/remove-subagent-settings.mjs` strips it on request.

## Consequences

**Positive:**
- `AgentSession`, the settings type, the CLI parser, the system prompt, the keybinding table, and the package root exports lose every subagent-only branch.
- The public surface is smaller: no delegation tool, no experiment tools, no background registry, no depth option.
- Generic bash teardown keeps its descendant snapshot, so the orphan-process fix survives the deletion.

**Negative:**
- Users of the built-in `subagent` tool must switch to an extension that registers its own tool (for example, a third-party subagent extension). `.qi/agents/*.md` definitions are no longer read by the core.
- Background subagent runs, the experiments dashboard, and the supervisor channel disappear without replacement.

**Neutral:**
- `packages/agent/src` was already free of subagent code and stays that way.
- The `pi.agent.task` span type in `HARNESS_TELEMETRY_SCHEMA` (`packages/agent/src/harness/telemetry.ts`, documented in `packages/agent/docs/telemetry-schema.md`) keeps its schema but lost its only producers: `startSubagentTask`, `endSubagentTask`, and `newTaskSpanId` in `packages/coding-agent` were the sole emitters. Telemetry consumers reading that span type will now receive nothing. Removing or renaming the schema entry is deliberately out of scope for this coding-agent branch.
- No dependency is removed: every package the subsystem used (`proper-lockfile`, `better-sqlite3`, `cross-spawn`, `diff`, `hosted-git-info`, `ignore`, `jiti`, `minimatch`, `semver`, `typebox`, `yaml`) has other consumers.

## Alternatives considered

- **Keep the subsystem behind `subagent.enabled: false` by default:** Rejected. The code, its startup hygiene, its settings surface, and its tests would remain, and the depth guard would still have to cross the process boundary.
- **Keep the `subagent` tool but drop the experiments/worktree layer:** Rejected in the task scope: the remaining tool still drags in the runner, registry, control plane, and result contract, and the plan is a hard removal with no shim.
- **Ship a deprecation period with a warning:** Rejected. The feature never reached a released version, so there is no installed base to migrate.

## Compliance checklist

- [x] `git grep -n "core/subagent"` returns zero matches under `packages/`, `docs/` (except historical analysis), and `specs/` live docs.
- [x] `git grep -n "subagentDepth\|--subagent-depth\|getSubagent\|DEFAULT_SUBAGENT_SETTINGS"` returns zero matches.
- [x] `test ! -d packages/coding-agent/src/core/subagent` and `test ! -d packages/coding-agent/examples/extensions/subagent` pass.
- [x] `bun run check` passes.
- [x] A `settings.json` containing `{"subagent":{"enabled":true}}` loads without error and keeps the key on rewrite.

## Traceability

- **Supersedes:** `ADR-0004`.
- **Realises:** the removal half of `REQ-SUBAG` (the subsystem requirements are retired with this ADR).
- **Referenced specs:** `specs/00-requirements/features/rebrand-requirements.md` (domain scoping), `specs/README.md`.