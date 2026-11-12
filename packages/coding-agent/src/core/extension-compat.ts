import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getPackageDir } from "../config.ts";

export const EXTENSION_COMPAT_MANIFEST_FILENAME = "extension-compat-manifest.json";
export const EXTENSION_COMPAT_SCHEMA_VERSION = 1;
export const E_EXT_NO_COMPATIBLE_VERSION = "E_EXT_NO_COMPATIBLE_VERSION";

export interface ExtensionCompatEntry {
	range?: string;
	gitRef?: string;
}

export interface ExtensionCompatManifest {
	schemaVersion: number;
	forkBaseline: string;
	upstreamCeiling: string;
	cutoffDate: string;
	packages: Record<string, ExtensionCompatEntry>;
}

let cached: ExtensionCompatManifest | undefined;

function defaultManifest(): ExtensionCompatManifest {
	return {
		schemaVersion: EXTENSION_COMPAT_SCHEMA_VERSION,
		forkBaseline: "0.85.0-b1",
		upstreamCeiling: "0.85.1",
		cutoffDate: "2026-09-05T23:59:59.999Z",
		packages: {},
	};
}

function findManifestPath(): string | undefined {
	const packageDir = getPackageDir();
	// Bun binary ships flat assets next to the executable; source and dist builds
	// keep the manifest beside the compiled `core` module.
	const sourceOrDist = existsSync(join(packageDir, "src")) ? "src" : "dist";
	const candidates = [
		join(packageDir, "core", EXTENSION_COMPAT_MANIFEST_FILENAME),
		join(packageDir, sourceOrDist, "core", EXTENSION_COMPAT_MANIFEST_FILENAME),
	];
	return candidates.find((candidate) => existsSync(candidate));
}

export function loadExtensionCompatManifest(): ExtensionCompatManifest {
	if (cached) return cached;

	const path = findManifestPath();
	if (!path) {
		cached = defaultManifest();
		return cached;
	}

	const parsed = JSON.parse(readFileSync(path, "utf-8")) as ExtensionCompatManifest;
	if (parsed.schemaVersion !== EXTENSION_COMPAT_SCHEMA_VERSION) {
		throw new Error(`Unsupported ${EXTENSION_COMPAT_MANIFEST_FILENAME} schemaVersion: ${parsed.schemaVersion}`);
	}
	cached = parsed;
	return parsed;
}

export function getCompatibleNpmRange(packageName: string): string | undefined {
	return loadExtensionCompatManifest().packages[packageName]?.range;
}

export function isListedExtension(packageName: string): boolean {
	return Object.hasOwn(loadExtensionCompatManifest().packages, packageName);
}

export function setExtensionCompatManifestForTests(manifest: ExtensionCompatManifest | undefined): void {
	cached = manifest;
}
