# Changelog

## [Unreleased]

## [0.85.2]

### Fixed

- Corrected the package name to `@bramburn/qi-clipboard-rs` so the coding-agent native loader resolves it instead of always falling back to `@mariozechner/clipboard`.
- Added `require` and `default` export conditions so CommonJS `require("@bramburn/qi-clipboard-rs")` no longer throws `ERR_PACKAGE_PATH_NOT_EXPORTED`.

## [0.85.1]

### Changed

- Published to the public npm registry as `@bramburn/qi-clipboard-rs` at `0.85.1`, the first release under the `@bramburn` scope.