import { describe, expect, it } from "vitest";
import { DEFAULT_DEEPSEEK_HARNESS, type Settings, SettingsManager } from "../src/core/settings-manager.ts";

function manager(settings: Partial<Settings>): SettingsManager {
	return SettingsManager.inMemory(settings);
}

describe("deepseekHarness collapse-superseded-edit settings", () => {
	it("defaults to off with an 8192-char threshold", () => {
		const resolved = manager({}).getDeepseekHarnessSettings();
		expect(resolved.collapseSupersededEdits).toBe(false);
		expect(resolved.editCollapseThresholdChars).toBe(8192);
		expect(DEFAULT_DEEPSEEK_HARNESS.collapseSupersededEdits).toBe(false);
		expect(DEFAULT_DEEPSEEK_HARNESS.editCollapseThresholdChars).toBe(8192);
	});

	it("keeps user values through the minimax profile merge", () => {
		const resolved = manager({
			deepseekHarness: { enabled: true, collapseSupersededEdits: true, editCollapseThresholdChars: 2048 },
		}).getDeepseekHarnessSettings({ provider: "minimax", id: "minimax-m2" });

		expect(resolved.profile).toBe("minimax");
		expect(resolved.collapseSupersededEdits).toBe(true);
		expect(resolved.editCollapseThresholdChars).toBe(2048);
	});

	it("applies exact-model and provider-wildcard overrides to the new fields", () => {
		const exact = manager({
			deepseekHarness: {
				enabled: true,
				modelPolicies: {
					"minimax/minimax-m2": { collapseSupersededEdits: true, editCollapseThresholdChars: 4096 },
				},
			},
		}).getDeepseekHarnessSettings({ provider: "minimax", id: "minimax-m2" });
		expect(exact.collapseSupersededEdits).toBe(true);
		expect(exact.editCollapseThresholdChars).toBe(4096);

		const wildcard = manager({
			deepseekHarness: {
				enabled: true,
				modelPolicies: {
					"minimax/*": { collapseSupersededEdits: true, editCollapseThresholdChars: 1024 },
				},
			},
		}).getDeepseekHarnessSettings({ provider: "minimax", id: "minimax-m2" });
		expect(wildcard.collapseSupersededEdits).toBe(true);
		expect(wildcard.editCollapseThresholdChars).toBe(1024);
	});

	it("does not apply model policies outside the minimax family", () => {
		const resolved = manager({
			deepseekHarness: {
				enabled: true,
				modelPolicies: { "openai/*": { collapseSupersededEdits: true } },
			},
		}).getDeepseekHarnessSettings({ provider: "openai", id: "gpt-5" });

		expect(resolved.profile).toBe("user");
		expect(resolved.collapseSupersededEdits).toBe(false);
	});
});
