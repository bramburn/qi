/**
 * Settings transform for the removal of the native subagent subsystem (ADR-0007).
 *
 * The subsystem's `subagent.*` keys are no longer read or written. A settings
 * file that still carries them loads fine — the settings reader keeps unknown
 * top-level keys — so this transform is only for users who want the dead keys
 * gone. It is deliberately pure: no file IO, no environment reads, no network.
 */

export type SettingsRecord = Record<string, unknown>;

export interface StripSubagentSettingsResult {
	/** A shallow copy of the input with every `subagent` key removed. */
	settings: SettingsRecord;
	/** Top-level keys that were removed, in source order. */
	removed: string[];
}

/**
 * Remove every top-level `subagent` settings key.
 *
 * Both the nested form written by qi (`subagent: { enabled, maxDepth, ... }`)
 * and a flat dotted form (`"subagent.enabled": true`) are removed. Every other
 * key, including unknown keys, is preserved. Non-object input yields an empty
 * settings object rather than throwing.
 */
export function stripSubagentSettings(raw: unknown): StripSubagentSettingsResult {
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
		return { settings: {}, removed: [] };
	}
	const settings: SettingsRecord = { ...(raw as SettingsRecord) };
	const removed: string[] = [];
	for (const key of Object.keys(settings)) {
		if (key === "subagent" || key.startsWith("subagent.")) {
			delete settings[key];
			removed.push(key);
		}
	}
	return { settings, removed };
}
