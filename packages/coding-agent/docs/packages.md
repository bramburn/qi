> qi can help you create qi packages. Ask it to bundle your extensions, skills, prompt templates, or themes.

# Qi Packages

Qi packages bundle extensions, skills, prompt templates, and themes so you can share them through npm or git. A package can declare resources in `package.json` under the `qi` key, or use conventional directories.

## Table of Contents

- [Install and Manage](#install-and-manage)
- [Package Sources](#package-sources)
- [Creating a Qi Package](#creating-a-qi-package)
- [Package Structure](#package-structure)
- [Dependencies](#dependencies)
- [Package Filtering](#package-filtering)
- [Enable and Disable Resources](#enable-and-disable-resources)
- [Scope and Deduplication](#scope-and-deduplication)

## Install and Manage

> **Security:** Qi packages run with full system access. Extensions execute arbitrary code, and skills can instruct the model to perform any action including running executables. Review source code before installing third-party packages.

```bash
qi install npm:@foo/bar@1.0.0
qi install git:github.com/user/repo@v1
qi install https://github.com/user/repo  # raw URLs work too
qi install /absolute/path/to/package
qi install ./relative/path/to/package

qi remove npm:@foo/bar
qi list                     # show installed packages from settings
qi update                   # update qi only
qi update --all             # update qi, update packages, and reconcile pinned git refs
qi update --extensions      # update packages and reconcile pinned git refs only
qi update --models          # refresh model catalogs only
qi update --self            # update qi only
qi update --self --force    # reinstall qi even if current
qi update npm:@foo/bar      # update one package
qi update --extension npm:@foo/bar
```

These commands manage qi packages and `qi update` can update the qi CLI installation. For experimental installer-managed installations, `qi update` installs the exact checked version into a staged, lockfile-backed release and activates it only after verification, leaving the current release intact if the update fails. Managed installations do not support `--force`; rerun the installer to repair one. To uninstall qi itself, see [Quickstart](quickstart.md#uninstall).

By default, `install` and `remove` write to user settings (`~/.qi/agent/settings.json`). Use `-l` to write to project settings (`.qi/settings.json`) instead. Project settings can be shared with your team, and qi installs any missing packages automatically on startup after the project is trusted.

To try a package without installing it, use `--extension` or `-e`. This installs to a temporary directory for the current run only:

```bash
qi -e npm:@foo/bar
qi -e git:github.com/user/repo
```

## Package Sources

Qi accepts three source types in settings and `qi install`.

### npm

```
npm:@scope/pkg@1.2.3
npm:pkg
```

- Versioned specs are pinned and skipped by package updates (`qi update --extensions`, `qi update --all`).
- User installs go under `~/.qi/agent/npm/`.
- Project installs go under `.qi/npm/`.
- Set `npmCommand` in `settings.json` to pin npm package lookup and install operations to a specific wrapper command such as `mise` or `asdf`.

Example:

```json
{
  "npmCommand": ["mise", "exec", "node@20", "--", "npm"]
}
```

### git

```
git:github.com/user/repo@v1
git:git@github.com:user/repo@v1
https://github.com/user/repo@v1
ssh://git@github.com/user/repo@v1
```

- Without `git:` prefix, only protocol URLs are accepted (`https://`, `http://`, `ssh://`, `git://`).
- With `git:` prefix, shorthand formats are accepted, including `github.com/user/repo` and `git@github.com:user/repo`.
- HTTPS and SSH URLs are both supported.
- SSH URLs use your configured SSH keys automatically (respects `~/.ssh/config`).
- For non-interactive runs (for example CI), you can set `GIT_TERMINAL_PROMPT=0` to disable credential prompts and set `GIT_SSH_COMMAND` (for example `ssh -o BatchMode=yes -o ConnectTimeout=5`) to fail fast.
- Refs are pinned tags or commits. `qi update --extensions` and `qi update --all` do not move them to newer refs, but they do reconcile an existing clone to the configured ref.
- Use `qi install git:host/user/repo@new-ref` to update settings and move an existing package to a new pinned ref.
- Cloned to `~/.qi/agent/git/<host>/<path>` (global) or `.qi/git/<host>/<path>` (project).
- When reconciliation changes the checkout, qi resets and cleans the clone, then runs `npm install` if `package.json` exists.

**SSH examples:**
```bash
# git@host:path shorthand (requires git: prefix)
qi install git:git@github.com:user/repo

# ssh:// protocol format
qi install ssh://git@github.com/user/repo

# With version ref
qi install git:git@github.com:user/repo@v1.0.0
```

### Local Paths

```
/absolute/path/to/package
./relative/path/to/package
```

Local paths point to files or directories on disk and are added to settings without copying. Relative paths are resolved against the settings file they appear in. If the path is a file, it loads as a single extension. If it is a directory, qi loads resources using package rules.

## Fork compatibility (qi)

qi is a hard fork of qi pinned to the qi 0.85 API surface. Extension packages published for later qi versions may not load, so qi gates npm extension resolution in two ways.

### Checked-in compatibility manifest

`packages/coding-agent/src/core/extension-compat-manifest.json` maps known packages to the semver range that has been tested against qi. A listed package is resolved with `maxSatisfying(versions, range)`. If no published version matches, install and update fail with `E_EXT_NO_COMPATIBLE_VERSION`.

Add an entry only after testing the package against the fork:

```json
{
 "packages": {
  "pi-subagents": { "range": ">=0.5.0 <0.6.0" }
 }
}
```

### Unlisted packages

An unlisted package is capped at the last version published on or before the manifest's `cutoffDate` (the upstream 0.85.1 release date). This prevents a post-0.85 release from being installed automatically without requiring a curated entry for every package.

- `qi update --extensions` will not install a post-cutoff version. If no pre-cutoff version exists, the package is blocked and its currently installed version is pinned.
- `qi install npm:<pkg>` prefers a pre-cutoff version. If the package has no pre-cutoff release, the explicit install falls back to the newest version with a warning and persists the exact version.

Successful installs and updates persist `npm:<name>@<exact-version>` in `settings.json`. The exact version is pinned, so `qi update --extensions` will not move it again.

### Git packages

Git packages are pinned by tag or commit via `@ref` and are not subject to the npm publish-date cutoff. Use a pinned ref for reproducibility.

## Creating a Qi Package

Add a `qi` manifest to `package.json` or use conventional directories. Include the `qi-package` keyword for discoverability.

```json
{
  "name": "my-package",
  "keywords": ["qi-package"],
  "qi": {
    "extensions": ["./extensions"],
    "skills": ["./skills"],
    "prompts": ["./prompts"],
    "themes": ["./themes"]
  }
}
```

Paths are relative to the package root. Arrays support glob patterns and `!exclusions`. Positive manifest globs discover visible paths in lexical order. List dot-prefixed paths directly. If a glob would need to continue through a symlink, list the symlinked resource root directly.

### Gallery Metadata

Extensions and skills may carry gallery-style metadata. Add `video` or `image` fields to show a preview:

```json
{
  "name": "my-package",
  "keywords": ["qi-package"],
  "qi": {
    "extensions": ["./extensions"],
    "video": "https://example.com/demo.mp4",
    "image": "https://example.com/screenshot.png"
  }
}
```

- **video**: MP4 only. On desktop, autoplays on hover. Clicking opens a fullscreen player.
- **image**: PNG, JPEG, GIF, or WebP. Displayed as a static preview.

If both are set, video takes precedence.

## Package Structure

### Convention Directories

If no `qi` manifest is present, qi auto-discovers resources from these directories:

- `extensions/` loads `.ts` and `.js` files
- `skills/` recursively finds `SKILL.md` folders and loads top-level `.md` files as skills
- `prompts/` loads `.md` files
- `themes/` loads `.json` files

## Dependencies

Third party runtime dependencies belong in `dependencies` in `package.json`. Dependencies that do not register extensions, skills, prompt templates, or themes also belong in `dependencies`. When qi installs a package from npm or git, it runs `npm install`, so those dependencies are installed automatically.

Qi bundles core packages for extensions and skills. If you import any of these, list them in `peerDependencies` with a `"*"` range and do not bundle them: `@bramburn/qi-ai`, `@bramburn/qi-agent-core`, `@bramburn/qi-coding-agent`, `@bramburn/qi-tui`, `typebox`.

Other qi packages must be bundled in your tarball. Add them to `dependencies` and `bundledDependencies`, then reference their resources through `node_modules/` paths. Qi loads packages with separate module roots, so separate installs do not collide or share modules.

Example:

```json
{
  "dependencies": {
    "shitty-extensions": "^1.0.1"
  },
  "bundledDependencies": ["shitty-extensions"],
  "qi": {
    "extensions": ["extensions", "node_modules/shitty-extensions/extensions"],
    "skills": ["skills", "node_modules/shitty-extensions/skills"]
  }
}
```

## Package Filtering

Filter what a package loads using the object form in settings:

```json
{
  "packages": [
    "npm:simple-pkg",
    {
      "source": "npm:my-package",
      "extensions": ["extensions/*.ts", "!extensions/legacy.ts"],
      "skills": [],
      "prompts": ["prompts/review.md"],
      "themes": ["+themes/legacy.json"]
    }
  ]
}
```

`+path` and `-path` are exact paths relative to the package root.

- Omit a key to load all of that type.
- Use `[]` to load none of that type.
- `!pattern` excludes matches.
- `+path` force-includes an exact path.
- `-path` force-excludes an exact path.
- Filters layer on top of the manifest. They narrow down what is already allowed.

## Enable and Disable Resources

Use `qi config` to enable or disable extensions, skills, prompt templates, and themes from installed packages and local directories. `qi config` starts in global settings (`~/.qi/agent/settings.json`); press Tab to switch between global and project-local modes. Use `qi config -l` to start in project overrides (`.qi/settings.json`) with inherited global resources dimmed.

## Scope and Deduplication

Packages can appear in both global and project settings. If the same package appears in both, the project entry wins unless the project entry has `autoload: false`, in which case it is applied as a delta over the global entry. Identity is determined by:

- npm: package name
- git: repository URL without ref
- local: resolved absolute path
