/**
 * Bash Spawn Hook Example
 *
 * Adjusts command, cwd, and env before execution.
 *
 * Usage:
 *   qi -e ./bash-spawn-hook.ts
 */

import type { ExtensionAPI } from "@bramburn/qi-coding-agent";
import { createBashTool } from "@bramburn/qi-coding-agent";

export default function (qi: ExtensionAPI) {
	const cwd = process.cwd();

	const bashTool = createBashTool(cwd, {
		spawnHook: ({ command, cwd, env }) => ({
			command: `source ~/.profile\n${command}`,
			cwd,
			env: { ...env, QI_SPAWN_HOOK: "1" },
		}),
	});

	qi.registerTool({
		...bashTool,
		execute: async (id, params, signal, onUpdate, _ctx) => {
			return bashTool.execute(id, params, signal, onUpdate);
		},
	});
}
