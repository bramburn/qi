# qi Spec Index

Single entry point for the qi spec set (Universal Spec Guidance, `specs/GUIDE.md`).
`specs/manifest.json` is the **only source of truth** for spec status, ids, paths, and batch derivation.

- **Mode:** `hybrid` (brownfield core; some domains describe pending batch work)
- **Stack:** `typescript`, `bun`

## Domains

- **`rebrand`** — Hard-cut rename from `pi` to `qi` (`@bramburn/qi-*`, `qi` binary, `QI_*` environment variables, `~/.qi/` and `.qi/` state directories) and complete severance of upstream `earendil-works`/`pi.dev` endpoints and sync tooling.
- **`extensions`** — Checked-in 0.85 compatibility manifest resolved at extension install time, persisting exact pinned versions in settings and warning while installing `latest` for unlisted packages.
- **`subagents`** — Retirement of the native subagent subsystem (ADR-0007), which superseded ADR-0004 (the earlier decision to make that subsystem the only implementation). The domain is kept for those two decision records only.
- **`compaction`** — Typed skip outcomes and threshold skip-latching so compaction no-ops ("already compacted", "nothing to summarise") never surface as repeated red TUI errors or error telemetry.

## Spec count per type

| Type | Count |
|---|---|
| requirements | 3 |
| adr | 7 (6 `accepted` + ADR-0004 `superseded`) |
| contract | 2 |
| behavior | 1 |
| impl | 2 |
| ux | 0 (`not_applicable`) |
| **Total** | **15** (14 `accepted`, 1 `superseded`) |

## The 5 most recently accepted ADRs

| ADR | Decision (one line) |
|---|---|
| [ADR-0002](adr/0002-sever-upstream-endpoints.md) | Sever every earendil-controlled endpoint and sync tooling: zero `pi.dev` traffic, no replacement hosted services, `/share` falls back to the raw Gist URL. |
| [ADR-0003](adr/0003-extension-compat-manifest.md) | Checked-in extension compatibility manifest resolved at install: listed packages pin to `compatibleRange` (fail hard with `E_EXT_NO_COMPATIBLE_VERSION` unless `--force`), unknown packages warn and fall back to `latest`. |
| [ADR-0007](adr/0007-remove-native-subagent.md) | Remove the native subagent subsystem completely, with no shim: no `subagent`/`experiment_*`/`contact_supervisor` tools, no `subagent.*` settings, no `--subagent-depth`; keep only the shared process helpers that generic bash teardown uses. |
| [ADR-0005](adr/0005-compaction-skip-not-error.md) | A compaction no-op is a typed skip, not an error: typed skip reasons, `compaction_end` with `skipped: true` and no `errorMessage`, blocking `compact()` rejects `CompactionSkippedError`, `compactInBackground()` resolves `undefined`. |
| [ADR-0006](adr/0006-npm-registry-self-update.md) | qi self-update resolves the latest `@bramburn/qi-coding-agent` from the npm registry packument (`dist-tags.latest`, 10 s timeout, retry ×3, `QI_OFFLINE` = silent skip); managed installer update disabled by default behind `QI_INSTALLER_API_BASE`. |

(ADR-0001 — hard-cut rename to qi with no legacy aliases — is the accepted root decision; see [adr/0001-qi-hard-cut-rebrand.md](adr/0001-qi-hard-cut-rebrand.md).)

## Spec set at a glance

| id | type | domain | status | path |
|---|---|---|---|---|
| REQ-REBRAND | requirements | rebrand | accepted | [00-requirements/features/rebrand-requirements.md](00-requirements/features/rebrand-requirements.md) |
| ADR-0001 | adr | rebrand | accepted | [adr/0001-qi-hard-cut-rebrand.md](adr/0001-qi-hard-cut-rebrand.md) |
| ADR-0002 | adr | rebrand | accepted | [adr/0002-sever-upstream-endpoints.md](adr/0002-sever-upstream-endpoints.md) |
| ADR-0006 | adr | rebrand | accepted | [adr/0006-npm-registry-self-update.md](adr/0006-npm-registry-self-update.md) |
| REQ-EXT | requirements | extensions | accepted | [00-requirements/features/extensions-requirements.md](00-requirements/features/extensions-requirements.md) |
| ADR-0003 | adr | extensions | accepted | [adr/0003-extension-compat-manifest.md](adr/0003-extension-compat-manifest.md) |
| CONTRACT-EXT-COMPAT-MANIFEST | contract | extensions | accepted | [contracts/json-schema/extension-compat-manifest.schema.json](contracts/json-schema/extension-compat-manifest.schema.json) |
| CONTRACT-EXT-COMPAT-MANIFEST-EXAMPLES | contract | extensions | accepted | [contracts/json-schema/extension-compat-manifest.examples.md](contracts/json-schema/extension-compat-manifest.examples.md) |
| BEHAV-EXT-INSTALL-PINNING | behavior | extensions | accepted | [features/extensions/install-pinning.feature](features/extensions/install-pinning.feature) |
| IMPL-EXTENSIONS | impl | extensions | accepted | [impl/extensions-phase.md](impl/extensions-phase.md) |
| ADR-0004 | adr | subagents | superseded | [adr/0004-native-subagent-self-sufficiency.md](adr/0004-native-subagent-self-sufficiency.md) |
| ADR-0007 | adr | subagents | accepted | [adr/0007-remove-native-subagent.md](adr/0007-remove-native-subagent.md) |
| REQ-COMPACTION | requirements | compaction | accepted | [00-requirements/features/compaction-requirements.md](00-requirements/features/compaction-requirements.md) |
| ADR-0005 | adr | compaction | accepted | [adr/0005-compaction-skip-not-error.md](adr/0005-compaction-skip-not-error.md) |
| IMPL-COMPACTION | impl | compaction | accepted | [impl/compaction-phase.md](impl/compaction-phase.md) |

## How to use this in batch

Every batch task's context is derived **mechanically** from `specs/manifest.json` (GUIDE §7) — never hand-curate:

- **Review this code** (`specs_for(P)`): take every spec whose `governs` glob matches the code path `P`, then close over `depends_on` transitively. Example: a change in `packages/coding-agent/src/core/package-manager.ts` pulls `REQ-EXT`, `ADR-0003`, `CONTRACT-EXT-COMPAT-MANIFEST`, `CONTRACT-EXT-COMPAT-MANIFEST-EXAMPLES`, `IMPL-EXTENSIONS`, plus `ADR-0002` (via `governs: packages/coding-agent/src/**`) and its dependency `ADR-0001`.
- **Review this domain** (`specs_for(D)`): take every spec with `domain == D`; its code context is the union of those specs' `governs` globs. Example: domain `compaction` → `REQ-COMPACTION`, `ADR-0005`, `IMPL-COMPACTION` → `agent-session.ts`, `compaction/compaction.ts`, `interactive-mode.ts`.
- **Truth in advertising:** behavior specs carry `verifies` (test bindings) or `aspirational: true` (`BEHAV-EXT-INSTALL-PINNING` is aspirational until `IMPL-EXTENSIONS` wires the step definitions).
- **Status:** only `accepted` (or `superseded`) specs may appear in `depends_on`; 14 of the 15 entries are `accepted` and ADR-0004 is `superseded` (ADR-0007 retired the subagent requirements and implementation specs and supersedes ADR-0004).

---

_Quality gates and authoring protocol: [`GUIDE.md`](GUIDE.md). Draft history: `specs/.history/` (not scanned by batch tools)._
