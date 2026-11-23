---
name: publish-qi-release
description: Cut and publish a new qi monorepo release to npm and create a vX.Y.Z git tag through GitHub Actions. Use when asked to release, publish, or tag a new qi version, or to recover a failed npm/GitHub release workflow.
---

# Publish a qi release

Repository: `bramburn/qi`. Packages are lockstep-versioned as `@bramburn/qi-*`.

Version rules:

- `patch` for fixes and additions.
- `minor` for breaking changes.
- No major releases.

The normal path is a `vX.Y.Z` tag pushed to `fork`. The tag triggers
`.github/workflows/build-binaries.yml`, which builds binaries, publishes npm
packages with OIDC trusted publishing, announces the verified release, and
publishes the GitHub Release. Do not run local `npm publish` when CI can do it.

## Guardrails

- Push only to `fork` (`https://github.com/bramburn/qi.git`). Never push to
  `origin` (`earendil-works/pi`), including `origin/main` and tags.
- Do not force-push, `git reset --hard`, `git clean -fd`, or use
  `git commit --no-verify`.
- Do not rerun the release script after a tag is already pushed.
- Do not merge into `fork/main` automatically.

## 1. Preflight

Confirm the target bump with the user and ask whether they ran `/cl` on the
latest `main` commit. Changelogs under `packages/*/CHANGELOG.md` must have an
audited `## [Unreleased]` section.

```bash
git status --short
git remote -v
git log --oneline -5
gh auth status
```

The worktree must be clean, or every dirty file must be an intentional release
artifact (for example `packages/ai/src/*.generated.ts`). Do not silently release
another session's unrelated work.

Verify the current lockstep version and npm state:

```bash
node --input-type=module -e "
import { getPublicWorkspacePackages } from './scripts/release-packages.mjs';
const versions = new Set(getPublicWorkspacePackages().map((p) => p.version));
console.log([...versions]);
"
npm view @bramburn/qi-coding-agent version dist-tags --json
```

`scripts/release.mjs` must push `fork`, not `origin`. Check before using it:

```bash
grep -n 'git push' scripts/release.mjs
```

If it still says `git push origin`, do not run it. Use the manual path below or
fix the remote in a separate reviewed commit.

## 2. Normal release path

Run from the repository root:

```bash
QI_ALLOW_LOCKFILE_CHANGE=1 npm_config_min_release_age=0 bun run release:patch
# or: QI_ALLOW_LOCKFILE_CHANGE=1 npm_config_min_release_age=0 bun run release:minor
```

The script bumps all public packages, moves `[Unreleased]` to the release
version, regenerates release artifacts, runs `bun run check` and `./test.sh`,
commits `Release vX.Y.Z`, tags `vX.Y.Z`, adds fresh `[Unreleased]` sections,
commits that, then pushes `main` and the tag.

On Windows, `./test.sh` is now launched through `bash`, not `cmd.exe`. Use the
focused local smoke test when the full Windows suite has known unrelated
failures:

```powershell
bun run release:local -- --out C:\temp\qi-local-release --force
```

## 3. Manual release path

Use this only when the release script cannot run, for example because the local
test suite has unrelated failures that CI is expected to resolve. CI still runs
the full Linux test suite on `main` and the tag before publishing.

Set the version once:

```bash
VERSION=0.85.3
```

Bump package versions and lockfiles:

```bash
QI_ALLOW_LOCKFILE_CHANGE=1 npm_config_min_release_age=0 bun run version:patch
# or: ... bun run version:minor
```

Move every `## [Unreleased]` heading to the release version and date:

```bash
RELEASE_DATE=$(date +%F) node --input-type=module -e "
import { readFileSync, writeFileSync } from 'node:fs';
import { findPackageDirectories } from './scripts/package-workspaces.mjs';
import { join } from 'node:path';
const version = process.env.VERSION;
const date = new Date().toISOString().split('T')[0];
if (!version) throw new Error('set VERSION');
for (const dir of findPackageDirectories()) {
  const file = join(dir, 'CHANGELOG.md');
  let text;
  try { text = readFileSync(file, 'utf8'); } catch { continue; }
  if (!text.includes('## [Unreleased]')) continue;
  writeFileSync(file, text.replace('## [Unreleased]', \`## [\${version}] - \${date}\`));
  console.log('updated', file);
}
"
```

Regenerate release artifacts and verify:

```bash
bun run generate:models
bun run check:model-data
bun run shrinkwrap:coding-agent
bun run install-lock:coding-agent
bun run check
bun run build:offline
./test.sh
```

If `./test.sh` fails, inspect the failures. Do not tag a release with unexplained
failures. If the failures are pre-existing and environment-specific, record them
and rely on the Linux CI run; do not hide them by disabling tests.

Commit the release, tag it, then add the next `[Unreleased]` section:

```bash
git add -A
git commit -m "Release v$VERSION"
git tag "v$VERSION"
```

Prefer explicit paths over `git add -A` when other changes exist. Add a fresh
`## [Unreleased]` section after `# Changelog` in every released changelog, then:

```bash
git add packages/*/CHANGELOG.md
git commit -m "Add [Unreleased] section for next cycle"
```

Push to `fork` only:

```bash
git push fork main
git push fork "v$VERSION"
```

## 4. Watch CI

```bash
gh run list --repo bramburn/qi --workflow build-binaries.yml --limit 5
gh run watch <run-id> --repo bramburn/qi
```

The workflow order is: build binaries, smoke test binaries, stage a draft GitHub
Release, publish npm packages, announce the verified release, publish the GitHub
Release. The release is not complete until the npm publish and announcement jobs
pass.

## 5. Recover a failed publish

If npm publishing failed after the tag was pushed, do not rerun the release
script. Re-run the failed job or use the manual publish workflow:

```bash
gh workflow run publish.yml --repo bramburn/qi \
  --ref "v$VERSION" \
  -f "tag=v$VERSION" \
  -f dry_run=true

gh workflow run publish.yml --repo bramburn/qi \
  --ref "v$VERSION" \
  -f "tag=v$VERSION"
```

If the log says `ENEEDAUTH` or mentions a registry auth failure, the package's
npmjs.com Trusted Publisher entry is missing or mismatched. It must target:

- Repository: `bramburn/qi`
- Workflow: `publish.yml`
- Environment: `npm-publish`

`scripts/publish-with-skip.mjs` is idempotent: a package version already on npm
is treated as success. Fix trusted-publisher configuration, then rerun the
workflow. Never fall back to a local `npm publish` unless the user explicitly
asks and the trusted-publisher path is impossible.

## 6. Verify the release

```bash
npm view @bramburn/qi-coding-agent version
gh release view "v$VERSION" --repo bramburn/qi
git ls-remote --tags fork "refs/tags/v$VERSION"
```

Confirm every public package resolves at the release version:

```bash
node --input-type=module -e "
import { getPublicWorkspacePackages } from './scripts/release-packages.mjs';
for (const pkg of getPublicWorkspacePackages()) console.log(pkg.name + '@' + pkg.version);
"
```