fn main() {
    let cargo_version = env!("CARGO_PKG_VERSION");
    let manifest_dir = std::env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR");
    let pkg_path = std::path::Path::new(&manifest_dir).join("package.json");
    let pkg = std::fs::read_to_string(&pkg_path)
        .unwrap_or_else(|e| panic!("failed to read {}: {e}", pkg_path.display()));
    let value: serde_json::Value = serde_json::from_str(&pkg)
        .unwrap_or_else(|e| panic!("failed to parse {}: {e}", pkg_path.display()));
    let npm_version = value
        .get("version")
        .and_then(|v| v.as_str())
        .unwrap_or_else(|| panic!("{} has no string 'version' field", pkg_path.display()));
    if npm_version != cargo_version {
        panic!(
            "version mismatch: Cargo.toml has {cargo_version}, package.json has {npm_version}. \
             Bump both to the same value. Automatic sync via the release script is a separate change."
        );
    }
    napi_build::setup();
}