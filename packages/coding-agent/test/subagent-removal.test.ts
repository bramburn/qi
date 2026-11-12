import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseArgs } from "../src/cli/args.ts";
import { stripSubagentSettings } from "../src/core/remove-subagent-settings.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { allToolNames } from "../src/core/tools/index.ts";

// ADR-0007: the native subagent subsystem is removed with no shim.

describe("native subagent removal", () => {
	let tempDir = "";
	let agentDir = "";
	let projectDir = "";

	beforeEach(() => {
		tempDir = join(tmpdir(), `qi-subagent-removal-${process.pid}-${Date.now()}`);
		agentDir = join(tempDir, "agent");
		projectDir = join(tempDir, "project");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(join(projectDir, ".qi"), { recursive: true });
	});

	afterEach(() => {
		if (existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true });
	});

	it("registers no subagent, experiment, or supervisor tool", () => {
		const names: string[] = [...allToolNames];
		expect(names.filter((name) => name === "subagent" || name.startsWith("experiment_"))).toEqual([]);
		expect(names).toEqual(["read", "bash", "powershell", "edit", "write", "grep", "find", "ls"]);
	});

	it("rejects --subagent-depth as an unknown flag", () => {
		const parsed = parseArgs(["--subagent-depth", "2"]);
		expect(parsed.unknownFlags.get("subagent-depth")).toBe("2");
		expect("subagentDepth" in parsed).toBe(false);
		expect(parsed.diagnostics).toEqual([]);
	});

	it("strips nested and dotted subagent settings while preserving siblings", () => {
		const { settings, removed } = stripSubagentSettings({
			theme: "dark",
			subagent: { enabled: true, maxDepth: 1 },
			"subagent.enabled": true,
			defaultModel: "claude-sonnet",
		});
		expect(removed).toEqual(["subagent", "subagent.enabled"]);
		expect(settings).toEqual({ theme: "dark", defaultModel: "claude-sonnet" });
	});

	it("tolerates a legacy subagent key and preserves it on rewrite", async () => {
		const settingsPath = join(agentDir, "settings.json");
		writeFileSync(settingsPath, JSON.stringify({ theme: "dark", subagent: { enabled: true } }));

		const manager = SettingsManager.create(projectDir, agentDir);
		expect(manager.getTheme()).toBe("dark");
		manager.setTheme("light");
		await manager.flush();

		const saved = JSON.parse(readFileSync(settingsPath, "utf8"));
		expect(saved.theme).toBe("light");
		expect(saved.subagent).toEqual({ enabled: true });
	});

	it("round-trips a settings file through the strip transform", () => {
		const settingsPath = join(agentDir, "settings.json");
		writeFileSync(settingsPath, JSON.stringify({ theme: "dark", subagent: { enabled: true } }));

		const { settings } = stripSubagentSettings(JSON.parse(readFileSync(settingsPath, "utf8")));
		writeFileSync(settingsPath, JSON.stringify(settings));

		const saved = JSON.parse(readFileSync(settingsPath, "utf8"));
		expect(saved).toEqual({ theme: "dark" });
	});
});
