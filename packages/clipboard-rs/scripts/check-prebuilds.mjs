#!/usr/bin/env node
import { readdirSync, statSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "prebuilds");

if (!existsSync(root)) {
	console.error("[check-prebuilds] prebuilds/ is missing. Run the matrix build first.");
	process.exit(1);
}

const files = [];

function walk(dir) {
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const p = join(dir, entry.name);
		if (entry.isDirectory()) walk(p);
		else if (entry.name.endsWith(".node")) files.push(p);
	}
}

walk(root);

if (files.length === 0) {
	console.error(
		"[check-prebuilds] no .node files under prebuilds/. Refusing to publish an empty binary package.",
	);
	process.exit(1);
}

for (const f of files) {
	if (statSync(f).size === 0) {
		console.error(`[check-prebuilds] ${f} is zero bytes.`);
		process.exit(1);
	}
}

const expected = [
	"linux-x64-gnu",
	"linux-arm64-gnu",
	"darwin-x64",
	"darwin-arm64",
	"win32-x64-msvc",
	"win32-arm64-msvc",
];
const present = new Set(files.map((f) => f.split(/[\\/]/).slice(-2, -1)[0]));
const missing = expected.filter((e) => !present.has(e));
if (missing.length > 0) {
	console.warn(`[check-prebuilds] warning: missing expected prebuild dirs: ${missing.join(", ")}`);
}

console.log(`[check-prebuilds] ok: ${files.length} .node file(s) in prebuilds/`);