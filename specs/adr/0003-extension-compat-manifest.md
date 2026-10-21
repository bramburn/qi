# ADR-0003: Extension compatibility manifest resolved at install

**Status:** draft
**Date:** 2026-10-20
**Domain:** extensions

## Context

`DefaultPackageManager.installNpm()` (`packages/coding-agent/src/core/package-manager.ts:1808-1812`) passes unpinned npm specs (`qi install npm:foo`) verbatim to `npm`/`bun`/`pnpm`, which resolves to registry `latest`. `installAndPersist()` (`:1029-1032`) persists the unpinned source string into `settings.json` (`:840-873`). Meanwhile, `loader.ts` (`packages/coding-agent/src/core/extensions/loader.ts:46-136`) performs no `API_VERSION`, `minPiVersion`, or `engines` check. Because `qi` is cutting ties with upstream `earendil-works/pi` at the `0.85.0-b1` baseline (Decisions D1, D4), third-party extensions on npm (`pi-package` keyword / `pi.dev/packages` gallery, `docs/packages.md:137`) that publish new versions for post-0.85 upstream APIs will break unpinned `qi install` users. However, `package-manager.ts` already has semver range resolution (`getLatestNpmVersion` + `maxSatisfying` at `:1491-1526`) and skips exact-version (`pinned: true`) packages during updates (`:59-66`, `:1107`, `:1204`).

## Decision

We will check in a static v1 compatibility manifest (`packages/coding-agent/src/core/extension-compat-manifest.json`, governed by `CONTRACT-EXT-COMPAT-MANIFEST`) mapping known 0.85-compatible extensions to semver ranges (and optional git refs), resolve unpinned installs against that manifest using `semver.maxSatisfying`, warn and fall back to registry `latest` for unlisted packages (Decision D3), and persist the exact resolved version (`npm:<name>@<version>`) in `settings.json`.

`[ASSUMPTION: getLatestNpmVersion() in packages/coding-agent/src/core/package-manager.ts:1491-1511 will query npm view <name> versions --json when resolving a manifest range so maxSatisfying receives the full version list — rationale: npm view <name> version --json returns only the single latest dist-tag string]`
`[UNRESOLVED: Whether a manifest-listed package with no published version matching compatibleRange should fail hard with E_EXT_NO_COMPATIBLE_VERSION or fall back to latest with a warning — suggested: fail hard with E_EXT_NO_COMPATIBLE_VERSION]`

## Consequences

**Positive:**
- Known ecosystem extensions install a verified 0.85-compatible version and are persisted as exact versions (`pinned: true`), preventing `qi update --extensions` from breaking them later.
- Unlisted or newly created community extensions still install with a clear warning (`R-EXT-004`).
- Zero runtime network dependency on `pi.dev/packages` or any external compatibility service (honours Decision D4).

**Negative:**
- Maintaining the checked-in manifest requires periodic curation commits when new 0.85-compatible patch releases are published by extension authors.
- Unpinned `qi install` requires an `npm view` metadata lookup before `npm install` to determine the exact version to persist.

**Neutral:**
- Explicitly versioned installs (`qi install npm:foo@2.0.0`) continue to install the requested version (with an advisory warning if outside the manifest range).

## Alternatives considered

- **Refuse-unknown strict mode:** Rejecting any package not in the manifest breaks private, local-org, and newly published extensions; explicitly rejected by human decision D3.
- **Semver range cap only (without manifest):** There is no uniform semver convention across third-party extensions indicating which major/minor version targets `0.85`.
- **Self-hosted registry mirror:** High operational burden and infrastructure cost; explicitly deferred by Decision D6.
- **No validation (status quo):** Unpinned `qi install` silently pulls post-0.85 breaking extension versions and leaves `settings.json` unpinned.

## Compliance checklist

- [ ] `packages/coding-agent/src/core/extension-compat-manifest.json` exists and validates against `specs/contracts/json-schema/extension-compat-manifest.schema.json`.
- [ ] `DefaultPackageManager.installAndPersist("npm:<listed>", ...)` resolves a version satisfying `compatibleRange` and writes `"npm:<listed>@<exactVersion>"` to `settings.json`.
- [ ] `DefaultPackageManager.installAndPersist("npm:<unlisted>", ...)` emits a warning, resolves `latest`, and writes `"npm:<unlisted>@<exactVersion>"` to `settings.json`.
- [ ] `DefaultPackageManager.update()` skips packages persisted with exact versions (`pinned === true`).
- [ ] No code under `packages/` queries `pi.dev/packages` during package resolution, install, or update.

## Traceability

- **Realises:** `REQ-EXT` (`R-EXT-001`, `R-EXT-002`, `R-EXT-003`, `R-EXT-004`, `R-EXT-005`, `R-EXT-006`, `R-EXT-007`)
- **Depends on ADRs:** none
- **Referenced by:** `CONTRACT-EXT-COMPAT-MANIFEST`, `BEHAV-EXT-INSTALL-PINNING`, `IMPL-EXTENSIONS`
