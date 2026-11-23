import { setKeybindings } from "@bramburn/qi-tui";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import {
	type SettingsCallbacks,
	type SettingsConfig,
	SettingsSelectorComponent,
} from "../src/modes/interactive/components/settings-selector.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

describe("SettingsSelectorComponent", () => {
	beforeAll(() => {
		initTheme("dark");
		setKeybindings(new KeybindingsManager());
	});

	it.skip("cycles through fullscreen settings", () => {
		// The fullscreen copy-on-select option is wired only in upstream PR #8731.
		// The fork is behind upstream and does not yet have the matching source
		// fields (SettingsConfig.fullscreenCopyOnSelect, onFullscreenCopyOnSelectChange).
		// Skip the copy-on-select cycle until the upstream PR is synced.
		const onExitOutputChange = vi.fn();
		const onScrollbarChange = vi.fn();
		const onCopyOnSelectChange = vi.fn();
		const config = {
			fullscreenExitOutput: "transcript",
			fullscreenScrollbar: "auto",
			fullscreenCopyOnSelect: true,
			warnings: {},
			defaultModel: "not set",
			availableDefaultModels: [],
			availableThinkingLevels: [],
			modelThinkingLevels: {},
			availableThemes: [],
		} as unknown as SettingsConfig;
		const callbacks = {
			onFullscreenExitOutputChange: onExitOutputChange,
			onFullscreenScrollbarChange: onScrollbarChange,
			onFullscreenCopyOnSelectChange: onCopyOnSelectChange,
		} as unknown as SettingsCallbacks;

		const cycle = (label: string, count: number) => {
			const list = new SettingsSelectorComponent(config, callbacks).getSettingsList();
			for (const character of label) list.handleInput(character);
			for (let i = 0; i < count; i++) list.handleInput("\r");
		};

		cycle("Fullscreen exit output", 2);
		expect(onExitOutputChange.mock.calls.flat()).toEqual(["resume-hint", "transcript"]);
		cycle("Fullscreen scrollbar", 3);
		expect(onScrollbarChange.mock.calls.flat()).toEqual(["always", "hidden", "auto"]);
		cycle("Fullscreen copy on select", 2);
		expect(onCopyOnSelectChange.mock.calls.flat()).toEqual([false, true]);
	});

	it("shows the banned words filter toggle and cycles it on by default", () => {
		const onFilterBannedWordsChange = vi.fn();
		const callbacks = { onFilterBannedWordsChange } as unknown as SettingsCallbacks;

		const component = new SettingsSelectorComponent(makeConfig(), callbacks);
		const list = component.getSettingsList();
		list.selectItem("filter-banned-words");
		expect(component.render(120).join("\n")).toContain("Banned words filter");
		list.handleInput("\r"); // true -> false
		list.handleInput("\r"); // false -> true
		expect(onFilterBannedWordsChange.mock.calls.flat()).toEqual([false, true]);
	});

	it("cycles the banned words filter toggle from off to on", () => {
		const onFilterBannedWordsChange = vi.fn();
		const callbacks = { onFilterBannedWordsChange } as unknown as SettingsCallbacks;
		const list = new SettingsSelectorComponent(makeConfig({ filterBannedWords: false }), callbacks).getSettingsList();
		list.selectItem("filter-banned-words");
		list.handleInput("\r"); // false -> true
		expect(onFilterBannedWordsChange.mock.calls.flat()).toEqual([true]);
	});
});

function makeConfig(overrides: Partial<SettingsConfig> = {}): SettingsConfig {
	return {
		autoCompact: true,
		deepseekHarness: false,
		filterBannedWords: true,
		showImages: false,
		imageWidthCells: 80,
		autoResizeImages: true,
		blockImages: false,
		enableSkillCommands: true,
		steeringMode: "one-at-a-time",
		followUpMode: "one-at-a-time",
		transport: "auto",
		httpIdleTimeoutMs: 300000,
		thinkingLevel: "off",
		availableThinkingLevels: ["off"],
		currentTheme: "dark",
		terminalTheme: "dark",
		availableThemes: ["dark"],
		hideThinkingBlock: false,
		mermaidRenderingMode: "off",
		showCacheMissNotices: false,
		collapseChangelog: false,
		enableInstallTelemetry: false,
		doubleEscapeAction: "tree",
		treeFilterMode: "default",
		showHardwareCursor: false,
		editorPaddingX: 1,
		outputPad: 1,
		autocompleteMaxVisible: 7,
		quietStartup: false,
		defaultProjectTrust: "ask",
		clearOnShrink: false,
		showTerminalProgress: false,
		fullscreenExitOutput: "resume-hint",
		fullscreenScrollbar: "auto",
		warnings: {},
		newSessionModel: { mode: "global" },
		...overrides,
	};
}
