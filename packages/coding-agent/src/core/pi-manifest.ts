import { readFileSync } from "node:fs";
import { stripBom } from "../utils/text.ts";

export interface PiManifest {
	extensions?: string[];
	skills?: string[];
	prompts?: string[];
	themes?: string[];
}

const RESOURCE_FIELDS = ["extensions", "skills", "prompts", "themes"] as const;

/**
 * Manifest keys read in precedence order.
 *
 * `qi` is the current key. `pi` is the legacy key used by every package
 * published for the upstream pi agent before the rebrand, so packages that
 * only declare `pi` keep loading their declared entries instead of falling
 * back to convention-directory auto-discovery (which loads every helper
 * module in `extensions/` and fails on all but the real entrypoint).
 */
const MANIFEST_KEYS = ["qi", "pi"] as const;

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function readPiManifest(packageJsonPath: string): PiManifest | null {
	try {
		const pkg: unknown = JSON.parse(stripBom(readFileSync(packageJsonPath, "utf-8")));
		if (!isObject(pkg)) {
			return null;
		}

		const manifest: PiManifest = {};
		let foundManifest = false;
		for (const key of MANIFEST_KEYS) {
			const block = pkg[key];
			if (!isObject(block)) continue;
			foundManifest = true;
			for (const field of RESOURCE_FIELDS) {
				// Earlier keys win: a package that declares both `qi` and `pi`
				// keeps the `qi` entries for any field it specifies.
				if (manifest[field] !== undefined) continue;
				const entries = block[field];
				if (Array.isArray(entries) && entries.every((entry) => typeof entry === "string")) {
					manifest[field] = entries;
				}
			}
		}
		return foundManifest ? manifest : null;
	} catch {
		return null;
	}
}
