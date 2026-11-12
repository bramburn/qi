import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getPackageDir } from "../src/config.ts";
import {
	EXTENSION_COMPAT_MANIFEST_FILENAME,
	EXTENSION_COMPAT_SCHEMA_VERSION,
	getCompatibleNpmRange,
	isListedExtension,
	loadExtensionCompatManifest,
	setExtensionCompatManifestForTests,
} from "../src/core/extension-compat.ts";

function clearManifestCache(): void {
	setExtensionCompatManifestForTests(undefined);
}

describe("extension compat manifest", () => {
	afterEach(() => {
		clearManifestCache();
	});

	it("reads the checked-in manifest", () => {
		clearManifestCache();
		const manifest = loadExtensionCompatManifest();
		expect(manifest.schemaVersion).toBe(EXTENSION_COMPAT_SCHEMA_VERSION);
		expect(manifest.forkBaseline).toMatch(/^0\.85\./);
		expect(manifest.upstreamCeiling).toMatch(/^0\.85\./);
		expect(Number.isNaN(new Date(manifest.cutoffDate).getTime())).toBe(false);
		expect(manifest.packages).toEqual({});
	});

	it("ships the manifest beside the module", () => {
		const manifestPath = join(getPackageDir(), "src", "core", EXTENSION_COMPAT_MANIFEST_FILENAME);
		expect(manifestPath).toContain(EXTENSION_COMPAT_MANIFEST_FILENAME);
		expect(typeof getCompatibleNpmRange("unlisted-package")).toBe("undefined");
	});

	it("returns the default manifest when the file is missing", () => {
		clearManifestCache();
		const previous = process.env.QI_PACKAGE_DIR;
		process.env.QI_PACKAGE_DIR = join(process.cwd(), "does-not-exist");
		try {
			const manifest = loadExtensionCompatManifest();
			expect(manifest.schemaVersion).toBe(EXTENSION_COMPAT_SCHEMA_VERSION);
			expect(manifest.packages).toEqual({});
			expect(manifest.cutoffDate).toBe("2026-09-05T23:59:59.999Z");
		} finally {
			if (previous === undefined) {
				delete process.env.QI_PACKAGE_DIR;
			} else {
				process.env.QI_PACKAGE_DIR = previous;
			}
			clearManifestCache();
		}
	});

	it("resolves manifest ranges for listed packages only", () => {
		setExtensionCompatManifestForTests({
			schemaVersion: EXTENSION_COMPAT_SCHEMA_VERSION,
			forkBaseline: "0.85.0-b1",
			upstreamCeiling: "0.85.1",
			cutoffDate: "2026-09-05T23:59:59.999Z",
			packages: { "pi-subagents": { range: ">=0.5.0 <0.6.0" } },
		});

		expect(getCompatibleNpmRange("pi-subagents")).toBe(">=0.5.0 <0.6.0");
		expect(getCompatibleNpmRange("unlisted-package")).toBeUndefined();
		expect(isListedExtension("pi-subagents")).toBe(true);
		expect(isListedExtension("unlisted-package")).toBe(false);
	});

	it("lets tests replace and clear the cached manifest", () => {
		clearManifestCache();
		const first = loadExtensionCompatManifest();
		expect(first.packages).toEqual({});

		setExtensionCompatManifestForTests({
			schemaVersion: EXTENSION_COMPAT_SCHEMA_VERSION,
			forkBaseline: "0.85.0-b1",
			upstreamCeiling: "0.85.1",
			cutoffDate: "2026-09-05T23:59:59.999Z",
			packages: { listed: { range: "^1.0.0" } },
		});
		expect(getCompatibleNpmRange("listed")).toBe("^1.0.0");

		setExtensionCompatManifestForTests(undefined);
		expect(getCompatibleNpmRange("listed")).toBeUndefined();
	});
});
