#!/usr/bin/env bun
/**
 * Strip dead `subagent.*` keys from qi settings files (ADR-0007).
 *
 * Deliberately manual: the removal is code-only and setting the keys is
 * already harmless, so nothing runs this automatically.
 *
 * Usage:
 *   bun packages/coding-agent/scripts/remove-subagent-settings.mjs
 *   bun packages/coding-agent/scripts/remove-subagent-settings.mjs <file> [...]
 *
 * With no arguments it targets the user settings file under `~/.qi/agent`.
 * A missing file is a no-op. Files are written atomically (temp file + rename).
 */
import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { stripSubagentSettings } from "../src/core/remove-subagent-settings.ts";

const targets = process.argv.slice(2);
if (targets.length === 0) {
	targets.push(join(homedir(), ".qi", "agent", "settings.json"));
}

for (const target of targets) {
	if (!existsSync(target)) {
		console.log(`skip ${target} (missing)`);
		continue;
	}
	const raw = readFileSync(target, "utf8");
	let parsed;
	try {
		parsed = JSON.parse(raw);
	} catch (error) {
		console.error(`skip ${target} (invalid JSON: ${error instanceof Error ? error.message : String(error)})`);
		continue;
	}
	const { settings, removed } = stripSubagentSettings(parsed);
	if (removed.length === 0) {
		console.log(`skip ${target} (no subagent keys)`);
		continue;
	}
	const temp = `${target}.tmp-${process.pid}`;
	writeFileSync(temp, `${JSON.stringify(settings, null, 2)}\n`);
	try {
		renameSync(temp, target);
	} catch (error) {
		try {
			unlinkSync(temp);
		} catch {
			// The temp file may already be gone; the original error is what matters.
		}
		throw error;
	}
	console.log(`updated ${target} (removed ${removed.join(", ")})`);
}