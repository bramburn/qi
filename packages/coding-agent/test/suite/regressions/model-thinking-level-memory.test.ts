import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ThinkingLevel } from "@bramburn/qi-agent-core";
import { getModel } from "@bramburn/qi-ai/compat";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAgentSession } from "../../../src/core/sdk.ts";
import { SessionManager } from "../../../src/core/session-manager.ts";
import type { Settings } from "../../../src/core/settings-manager.ts";
import { SettingsManager } from "../../../src/core/settings-manager.ts";
import { createHarness, type Harness } from "../harness.ts";

/**
 * Bug: the thinking level fell back to the global default (`medium`) on every
 * new session and model activation, so a per-model choice made with `/thinking`,
 * the thinking picker, Shift+Tab, or the RPC commands was forgotten.
 *
 * Contract: user-initiated changes are remembered per model under
 * `modelThinkingLevels` and restored when a session starts or the active model
 * changes. Session history and explicit per-session values still win.
 */
const MODEL = getModel("anthropic", "claude-sonnet-4-5")!;

describe("thinking level memory per model", () => {
	const harnesses: Harness[] = [];
	let tempDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-thinking-memory-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
	});

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
		if (existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	async function createSession(options: {
		settings?: Partial<Settings>;
		sessionManager?: SessionManager;
		thinkingLevel?: ThinkingLevel;
	}) {
		const settingsManager = SettingsManager.inMemory(options.settings ?? {});
		const sessionManager = options.sessionManager ?? SessionManager.inMemory(tempDir);
		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir: join(tempDir, "agent"),
			model: MODEL,
			thinkingLevel: options.thinkingLevel,
			settingsManager,
			sessionManager,
		});
		return { session, settingsManager, sessionManager };
	}

	it("starts a new session at the remembered level instead of the global default", async () => {
		const first = await createSession({
			settings: {
				defaultThinkingLevel: "medium",
				modelThinkingLevels: { [`${MODEL.provider}/${MODEL.id}`]: "minimal" },
			},
		});
		expect(first.session.thinkingLevel).toBe("minimal");
		first.session.dispose();
	});

	it("remembers a user change so a fresh session restores it", async () => {
		const first = await createSession({ settings: { defaultThinkingLevel: "medium" } });
		first.session.setThinkingLevel("minimal");
		expect(first.settingsManager.getModelThinkingLevel(MODEL.provider, MODEL.id)).toBe("minimal");
		first.session.dispose();

		// A second SettingsManager over the same in-memory values models a restart.
		const second = await createSession({
			settings: first.settingsManager.getGlobalSettings(),
		});
		expect(second.session.thinkingLevel).toBe("minimal");
		second.session.dispose();
	});

	it("does not persist an explicitly constructed thinking level", async () => {
		const { session, settingsManager } = await createSession({
			settings: { defaultThinkingLevel: "medium" },
			thinkingLevel: "high",
		});

		expect(settingsManager.getModelThinkingLevel(MODEL.provider, MODEL.id)).toBeUndefined();
		expect(settingsManager.getDefaultThinkingLevel()).toBe("medium");
		session.dispose();
	});

	it("resumed session history wins over the remembered map", async () => {
		const sessionManager = SessionManager.inMemory(tempDir);
		sessionManager.appendModelChange(MODEL.provider, MODEL.id);
		sessionManager.appendThinkingLevelChange("high");
		sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "resumed" }],
			timestamp: Date.now(),
		});

		const { session } = await createSession({
			sessionManager,
			settings: {
				defaultThinkingLevel: "medium",
				modelThinkingLevels: { [`${MODEL.provider}/${MODEL.id}`]: "minimal" },
			},
		});

		expect(session.thinkingLevel).toBe("high");
		session.dispose();
	});

	it("keeps remembered levels isolated per model and reapplies them on switch", async () => {
		const harness = await createHarness({
			models: [
				{ id: "faux-1", name: "One", reasoning: true },
				{ id: "faux-2", name: "Two", reasoning: true },
			],
		});
		harnesses.push(harness);

		harness.session.setThinkingLevel("low");
		await harness.session.setModel(harness.getModel("faux-2")!);
		harness.session.setThinkingLevel("high");

		expect(harness.settingsManager.getModelThinkingLevel("faux", "faux-1")).toBe("low");
		expect(harness.settingsManager.getModelThinkingLevel("faux", "faux-2")).toBe("high");

		await harness.session.setModel(harness.getModel("faux-1")!);
		expect(harness.session.thinkingLevel).toBe("low");

		await harness.session.setModel(harness.getModel("faux-2")!);
		expect(harness.session.thinkingLevel).toBe("high");
	});

	it("clamps an unsupported remembered level without overwriting it", async () => {
		const harness = await createHarness({
			models: [
				{ id: "faux-1", name: "One", reasoning: true },
				{ id: "faux-2", name: "Two", reasoning: true },
			],
		});
		harnesses.push(harness);
		// faux-2 cannot run at `minimal`; the nearest supported level is `low`.
		harness.getModel("faux-2")!.thinkingLevelMap = { minimal: null };
		harness.settingsManager.setModelThinkingLevel("faux", "faux-2", "minimal");

		await harness.session.setModel(harness.getModel("faux-2")!);

		expect(harness.session.thinkingLevel).toBe("low");
		expect(harness.settingsManager.getModelThinkingLevel("faux", "faux-2")).toBe("minimal");
	});
});

describe("SettingsManager.modelThinkingLevels", () => {
	it("round-trips values, keys by provider/modelId, and preserves unrelated settings", () => {
		const settings = SettingsManager.inMemory({ lastChangelogVersion: "1.2.3", defaultThinkingLevel: "low" });

		settings.setModelThinkingLevel("openrouter", "deepseek/deepseek-r1", "high");
		settings.setModelThinkingLevel("anthropic", "claude-opus-4-8", "medium");

		expect(settings.getModelThinkingLevel("openrouter", "deepseek/deepseek-r1")).toBe("high");
		expect(settings.getModelThinkingLevel("anthropic", "claude-opus-4-8")).toBe("medium");
		expect(settings.getModelThinkingLevel("anthropic", "missing")).toBeUndefined();
		expect(settings.getAllModelThinkingLevels()).toEqual({
			"openrouter/deepseek/deepseek-r1": "high",
			"anthropic/claude-opus-4-8": "medium",
		});
		expect(settings.getLastChangelogVersion()).toBe("1.2.3");
		expect(settings.getDefaultThinkingLevel()).toBe("low");
	});

	it("overwriting one key leaves the others intact", () => {
		const settings = SettingsManager.inMemory({});
		settings.setModelThinkingLevel("p", "a", "low");
		settings.setModelThinkingLevel("p", "b", "high");
		settings.setModelThinkingLevel("p", "a", "max");

		expect(settings.getModelThinkingLevel("p", "a")).toBe("max");
		expect(settings.getModelThinkingLevel("p", "b")).toBe("high");
	});

	it("ignores invalid stored values without throwing", () => {
		const settings = SettingsManager.inMemory({
			defaultThinkingLevel: "medium",
			modelThinkingLevels: {
				"p/valid": "low",
				"p/bogus": "ludicrous",
				"p/number": 42,
			} as unknown as Record<string, ThinkingLevel>,
		});

		expect(settings.getModelThinkingLevel("p", "valid")).toBe("low");
		expect(settings.getModelThinkingLevel("p", "bogus")).toBeUndefined();
		expect(settings.getModelThinkingLevel("p", "number")).toBeUndefined();
		expect(settings.getDefaultThinkingLevel()).toBe("medium");
		expect(settings.getAllModelThinkingLevels()).toEqual({ "p/valid": "low" });
	});
});
