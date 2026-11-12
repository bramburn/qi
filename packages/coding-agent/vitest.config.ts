import { fileURLToPath } from "node:url";
import { defineConfig, mergeConfig } from "vitest/config";
import baseConfig, { workspaceSourcePaths } from "../../vitest.base.ts";

export default mergeConfig(
	baseConfig,
	defineConfig({
		test: {
			globals: true,
			environment: "node",
			testTimeout: 30000,
			// Tests run offline by default; opt in with allowNetwork() from test/test-network-env.ts.
			env: { QI_OFFLINE: "1" },
			unstubEnvs: true,
			reporters: process.env.GITHUB_ACTIONS ? ["dot", "github-actions"] : ["dot"],
			silent: "passed-only",
			// Exclude dist/ so vitest doesn't run copied .test.ts files that
			// ship in the build output (e.g. examples/extensions/background-tasks).
			// Setting `exclude` replaces vitest's defaults instead of extending them,
			// so node_modules has to be listed here: on Windows vitest follows the
			// workspace symlink at node_modules/@bramburn/qi-tui and would otherwise
			// pick up packages/tui's node:test suites and fail them with
			// "No test suite found" (vitest doesn't recognize describe/it from
			// node:test). Linux leaves the symlink alone, which is why CI never hits it.
			exclude: ["**/node_modules/**", "**/dist/**"],
			server: {
				deps: {
					// photon-node is a native WASM binding (better-sqlite3-style); vite's SSR
					// transformer cannot bundle native modules, so we exclude it from transformation.
					// Add any other native binding here.
					external: [/@silvia-odwyer\/photon-node/],
				},
			},
		},
		resolve: {
			// Windows installs keep a real directory at node_modules/openai and a nested
			// symlink at packages/ai/node_modules/openai, so the aliased @bramburn/qi-ai
			// source and a test's `vi.mock("openai")` resolve two distinct copies and the
			// mock never fires (the test then talks to the live endpoint). dedupe forces
			// one copy. Linux realpath's both to the same directory, which is why CI
			// passes without it.
			dedupe: ["openai"],
			alias: [
				{
					find: /^@earendil-works\/pi-client$/,
					replacement: fileURLToPath(new URL("../client/src/index.ts", import.meta.url)),
				},
				{
					find: /^@bramburn\/qi-client$/,
					replacement: fileURLToPath(new URL("../client/src/index.ts", import.meta.url)),
				},
				{
					find: /^@earendil-works\/pi-protocol$/,
					replacement: fileURLToPath(new URL("../protocol/src/index.ts", import.meta.url)),
				},
				{
					find: /^@bramburn\/qi-protocol$/,
					replacement: fileURLToPath(new URL("../protocol/src/index.ts", import.meta.url)),
				},
				{ find: /^@mariozechner\/pi-ai$/, replacement: workspaceSourcePaths.aiIndex },
				{ find: /^@mariozechner\/pi-ai\/oauth$/, replacement: workspaceSourcePaths.aiOAuth },
				{ find: /^@mariozechner\/pi-agent-core$/, replacement: workspaceSourcePaths.agentIndex },
				{ find: /^@mariozechner\/pi-tui$/, replacement: workspaceSourcePaths.tuiIndex },
			],
		},
	}),
);
