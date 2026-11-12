# Runbook: finish the native subagent removal after merge

ADR-0007 removes the native subagent subsystem in code. No step in this file ran
during the removal; run these only after the removal is merged and released.

## 1. Verify the release no longer ships the subsystem

```bash
qi --help | grep -c -- "--subagent-depth"   # expect 0
qi --tools subagent -p "say ok"             # expect an "unknown tool" warning
```

## 2. Strip dead settings keys (optional)

A `subagent` key in `settings.json` is ignored and preserved by the settings
reader, so this step is cosmetic. It writes atomically and skips files that have
no such keys.

```bash
# user settings only
bun packages/coding-agent/scripts/remove-subagent-settings.mjs

# user + a trusted project's settings
bun packages/coding-agent/scripts/remove-subagent-settings.mjs \
  "$HOME/.qi/agent/settings.json" \
  ./.qi/settings.json
```

Confirm the result:

```bash
grep -n '"subagent"' "$HOME/.qi/agent/settings.json"   # expect no output
```

## 3. Remove leftover on-disk state

The subsystem kept state outside the settings file. Delete it only if no older qi
build still needs it.

- `~/.qi/agent/subagent-bg/` — background task rows and logs.
- `~/.qi/agent/experiments/` (or the project-local `.qi-experiments/`) — experiment
  registry and logs.
- `.worktrees/` — experiment worktrees. Check `git worktree list` first; remove
  only entries recorded under `.worktrees/`.
- Per-session `control/` and `supervisor/` directories next to background task
  rows.

## 4. Remove extension workarounds

Users who symlinked an extension named `subagent` did so to avoid the native
tool collision warning. That warning is gone; the symlink now simply provides the
tool. Keep it if the extension is wanted, remove it otherwise.

## 5. Re-check keybindings

Custom keybindings for `app.subagent.experimentsDashboard`,
`app.subagent.bgDashboardUp`, or `app.subagent.bgDashboardDown` are now unknown.
The keybinding loader does not error on unknown app actions; users can delete the
entries at their convenience.

## 6. Rollback

Revert the removal commit and reinstall. Nothing in the removal deleted user
data: `subagent` settings keys, `~/.qi/agent/subagent-bg/`, and experiment
registries are all left in place until step 3.