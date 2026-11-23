/**
 * Banned-words loader for the pre-LLM censoring filter.
 *
 * Resolves banned words from, in order:
 *  1. explicit user paths (settings `bannedWordsPath`, `QI_BANNED_WORDS_PATH`,
 *     `--banned-words-path`) — `.sqlite`/`.db` archives (hanzi-dict
 *     `banned_vocab.sqlite` shape), `banned_vocab.json`, or plain word lists
 *     (`.txt`/`.csv`/`.json`).
 *  2. well-known hanzi-dict locations discovered on disk
 *     (`apps/mobile/tool/banned_vocab.json`, `banned_vocab.sqlite`, and any
 *     `--archive-out` style directory holding a `banned_vocab.sqlite`).
 *  3. inline `settings.json` `bannedWords` entries.
 *
 * Results are cached per resolved path + mtime so repeated turns do not
 * re-read SQLite on every prompt. This module never writes anywhere: it only
 * reads.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

export const ENV_BANNED_WORDS_PATH = "QI_BANNED_WORDS_PATH";
export const ENV_FILTER_BANNED_WORDS = "QI_FILTER_BANNED_WORDS";

/**
 * Latin trigger spellings for hanzi-dict `political_remove` headwords. These
 * are the exact literals `apply_banned.py` uses in its FTS verification
 * queries (`MATCH 'Falun Gong'`, `MATCH 'Tiananmen'`), so tool output such
 * as `fts(FalunGong)=0` is masked even though the versioned JSON lists only
 * carry the CJK headwords. Plain text on purpose: this list only ever
 * matches outbound text and must stay auditable.
 */
const BASE_BANNED_WORD_ALIASES: readonly string[] = ["FalunGong", "Falun Gong", "Tiananmen"];

/** File names probed when a configured path is a directory. */
const DIRECTORY_CANDIDATE_FILES = ["banned_vocab.sqlite", "banned_vocab.json", "banned-words.txt", "banned-words.json"];

/**
 * Well-known hanzi-dict source locations, probed only when they exist on
 * disk. Covers the versioned list, the archive DB, and `--archive-out`
 * style output directories.
 */
const HANZI_DICT_CANDIDATES = [
	"c:/dev/hanzi-dict/apps/mobile/tool/banned_vocab.json",
	"c:/dev/hanzi-dict/apps/mobile/tool/banned_vocab.sqlite",
	"c:/dev/hanzi-dict/.tmp/banned-archive/banned_vocab.sqlite",
];

/**
 * Text columns harvested from SQLite tables. Definition/romanization
 * columns (`gloss`, `pinyin`, `action`, `reason`, ...) are never terms.
 * Tables whose names look like a ban/archive list (`banned`, `archive`,
 * ...) additionally match generic single-term columns (`value`, `entry`).
 */
const BANNED_TABLE_NAME_PATTERN = /ban|archiv|block|deny|filter|censor/i;
const BANNED_COLUMN_PATTERN = /^(simp|trad|hanzi|headword|word|term|keyword|name)$/i;
const BANNED_GENERIC_TERM_COLUMN_PATTERN = /^(value|text|entry|phrase)$/i;

interface CacheEntry {
	mtimeMs: number;
	words: string[];
}

const wordsCache = new Map<string, CacheEntry>();

export function clearBannedWordsCache(): void {
	wordsCache.clear();
}

function isBannedTableName(name: string): boolean {
	return BANNED_TABLE_NAME_PATTERN.test(name);
}

function isBannedColumnName(name: string): boolean {
	return BANNED_COLUMN_PATTERN.test(name);
}

function normalizeWord(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const word = value.trim();
	if (word.length === 0) return undefined;
	if (Array.from(word).length > 200) return undefined;
	return word;
}

/** Extract readable entries from a hanzi-dict `banned_vocab.json` document. */
function wordsFromBannedVocabJson(doc: unknown): string[] {
	if (doc === null || typeof doc !== "object") return [];
	const out: string[] = [];
	const record = doc as Record<string, unknown>;
	const denied = new Set<string>();
	const reviewed = record.reviewed_visible;
	if (reviewed !== null && typeof reviewed === "object") {
		for (const key of ["denylist", "benign_no_audio"] as const) {
			const list = (reviewed as Record<string, unknown>)[key];
			if (Array.isArray(list)) {
				for (const item of list) {
					if (typeof item === "string") denied.add(item);
				}
			}
		}
	}
	// Only the remove/gate lists are censorable; reviewed-visible benign
	// terms stay searchable and must not be masked.
	for (const key of ["political_remove", "explicit_gate"] as const) {
		const section = record[key];
		if (section === null || typeof section !== "object") continue;
		const entries = (section as { entries?: unknown }).entries;
		if (!Array.isArray(entries)) continue;
		for (const item of entries) {
			const word = normalizeWord(item);
			if (word !== undefined && !denied.has(word)) out.push(word);
		}
	}
	return out;
}

/** Extract words from a generic JSON word list (array or {entries|words|terms}). */
function wordsFromGenericJson(doc: unknown): string[] {
	const out: string[] = [];
	const push = (value: unknown) => {
		const word = normalizeWord(value);
		if (word !== undefined) out.push(word);
	};
	if (Array.isArray(doc)) {
		for (const item of doc) push(item);
		return out;
	}
	if (doc !== null && typeof doc === "object") {
		const record = doc as Record<string, unknown>;
		for (const key of ["entries", "words", "terms", "banned", "denylist"]) {
			const list = record[key];
			if (Array.isArray(list)) {
				for (const item of list) push(item);
			}
		}
	}
	return out;
}

/** Extract quoted literals that look like terms from a Python word-list file. */
function wordsFromPythonSource(text: string): string[] {
	const out: string[] = [];
	const literal = /["']([^"'\\\n]{2,120})["']/g;
	for (const match of text.matchAll(literal)) {
		const raw = match[1]!;
		// Skip code-ish strings; keep CJK terms and longer alphabetic words.
		if (/[;{}()=+\\]/.test(raw)) continue;
		if (/[\u4e00-\u9fff]/.test(raw)) {
			const word = normalizeWord(raw);
			if (word !== undefined) out.push(word);
		} else if (/^[A-Za-z][A-Za-z .()-]{3,}$/.test(raw)) {
			const word = normalizeWord(raw);
			if (word !== undefined) out.push(word);
		}
	}
	return out;
}

function wordsFromTextList(text: string): string[] {
	const out: string[] = [];
	for (const line of text.split(/\r?\n/)) {
		// Support .csv with one term per line and comma-separated single lines.
		for (const part of line.split(",")) {
			const word = normalizeWord(part.replace(/^["']|["']$/g, ""));
			if (word !== undefined) out.push(word);
		}
	}
	return out;
}

function wordsFromSqliteFile(path: string): string[] {
	const out: string[] = [];
	let db: DatabaseSync | undefined;
	try {
		// node:sqlite is builtin to Node 22+ and supported by the Bun
		// runtime, so no native binding install is needed. Opening a
		// missing file read-only throws and the source is skipped.
		db = new DatabaseSync(path, { readOnly: true });
		const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[];
		for (const { name } of tables) {
			if (name.startsWith("sqlite_") || name.endsWith("_fts_data") || name.endsWith("_fts_idx")) continue;
			const columns = db.prepare(`PRAGMA table_info("${name.replace(/"/g, '""')}")`).all() as {
				name: string;
				type: string;
			}[];
			const textColumns = columns.filter((c) => /TEXT|CHAR|CLOB/i.test(c.type) || c.type === "");
			if (textColumns.length === 0) continue;
			const bannedTable = isBannedTableName(name);
			const wanted = textColumns.filter(
				(c) => isBannedColumnName(c.name) || (bannedTable && BANNED_GENERIC_TERM_COLUMN_PATTERN.test(c.name)),
			);
			if (wanted.length === 0) continue;
			const selectCols = wanted.map((c) => `"${c.name.replace(/"/g, '""')}"`).join(", ");
			// Banned archives are small (hundreds of rows); full scan is fine.
			const rows = db
				.prepare(`SELECT ${selectCols} FROM "${name.replace(/"/g, '""')}" LIMIT 100000`)
				.all() as Record<string, unknown>[];
			for (const row of rows) {
				for (const col of wanted) {
					const word = normalizeWord(row[col.name]);
					if (word !== undefined) out.push(word);
				}
			}
		}
	} catch {
		return out;
	} finally {
		try {
			db?.close();
		} catch {
			// Ignore close errors on read-only handles.
		}
	}
	return out;
}

function wordsFromFile(path: string): string[] {
	const lower = path.toLowerCase();
	if (lower.endsWith(".sqlite") || lower.endsWith(".db")) {
		return wordsFromSqliteFile(path);
	}
	if (lower.endsWith(".json")) {
		try {
			const doc = JSON.parse(readFileSync(path, "utf-8")) as unknown;
			const vocab = wordsFromBannedVocabJson(doc);
			return vocab.length > 0 ? vocab : wordsFromGenericJson(doc);
		} catch {
			return [];
		}
	}
	if (lower.endsWith(".py")) {
		try {
			return wordsFromPythonSource(readFileSync(path, "utf-8"));
		} catch {
			return [];
		}
	}
	try {
		return wordsFromTextList(readFileSync(path, "utf-8"));
	} catch {
		return [];
	}
}

/** Expand a configured path into concrete files (directory → known files + *.sqlite). */
function expandConfiguredPath(path: string): string[] {
	let stat: ReturnType<typeof statSync> | undefined;
	try {
		stat = statSync(path);
	} catch {
		return [];
	}
	if (!stat.isDirectory()) {
		return stat.isFile() ? [path] : [];
	}
	const out: string[] = [];
	let entries: string[] = [];
	try {
		entries = readdirSync(path);
	} catch {
		return [];
	}
	for (const file of DIRECTORY_CANDIDATE_FILES) {
		const full = join(path, file);
		if (entries.includes(file) && existsSync(full)) out.push(full);
	}
	for (const entry of entries) {
		const lower = entry.toLowerCase();
		if ((lower.endsWith(".sqlite") || lower.endsWith(".db")) && !out.includes(join(path, entry))) {
			out.push(join(path, entry));
		}
	}
	return out;
}

/**
 * Split an env-provided path list (`;` on Windows, `:` on POSIX, or a
 * single path). A chunk that is a Windows absolute path (`C:\...`) is
 * never split on its drive-letter colon.
 */
export function splitEnvPathList(value: string): string[] {
	const out: string[] = [];
	for (const chunk of value.split(";")) {
		const trimmed = chunk.trim();
		if (trimmed.length === 0) continue;
		if (!trimmed.includes(":") || /^[A-Za-z]:[\\/]/.test(trimmed)) {
			out.push(trimmed);
		} else {
			for (const part of trimmed.split(":")) {
				const piece = part.trim();
				if (piece.length > 0) out.push(piece);
			}
		}
	}
	return out;
}

export interface BannedWordsSourceOptions {
	/** Explicit paths from settings/CLI (files or directories). */
	configuredPaths?: readonly string[];
	/** Raw QI_BANNED_WORDS_PATH-style env value, split internally. */
	envPathList?: string;
	/** Extra inline words from settings. */
	inlineWords?: readonly string[];
	/** When false, skips the hanzi-dict well-known locations. Default: true. */
	includeWellKnownPaths?: boolean;
	/** When false, skips the built-in latin alias list. Default: true. */
	includeBaseAliases?: boolean;
}

/**
 * Load and deduplicate banned words from every available source. Never
 * throws: unreadable sources are skipped. Returns words in first-seen order.
 */
export function loadBannedWords(options: BannedWordsSourceOptions = {}): string[] {
	const files: string[] = [];
	const seenFiles = new Set<string>();
	const pushFile = (path: string) => {
		if (!seenFiles.has(path)) {
			seenFiles.add(path);
			files.push(path);
		}
	};
	for (const path of options.configuredPaths ?? []) {
		for (const file of expandConfiguredPath(path)) pushFile(file);
	}
	if (options.envPathList) {
		for (const path of splitEnvPathList(options.envPathList)) {
			for (const file of expandConfiguredPath(path)) pushFile(file);
		}
	}
	if (options.includeWellKnownPaths !== false) {
		for (const path of HANZI_DICT_CANDIDATES) {
			if (existsSync(path)) pushFile(path);
		}
	}
	const out: string[] = [];
	const seenWords = new Set<string>();
	const pushWord = (word: string) => {
		const key = word.toLowerCase();
		if (!seenWords.has(key)) {
			seenWords.add(key);
			out.push(word);
		}
	};
	if (options.includeBaseAliases !== false) {
		for (const word of BASE_BANNED_WORD_ALIASES) pushWord(word);
	}
	for (const file of files) {
		let mtimeMs = 0;
		try {
			mtimeMs = statSync(file).mtimeMs;
		} catch {
			continue;
		}
		const cached = wordsCache.get(file);
		const words = cached !== undefined && cached.mtimeMs === mtimeMs ? cached.words : wordsFromFile(file);
		if (cached === undefined || cached.mtimeMs !== mtimeMs) {
			wordsCache.set(file, { mtimeMs, words });
		}
		for (const word of words) pushWord(word);
	}
	for (const word of options.inlineWords ?? []) {
		const normalized = normalizeWord(word);
		if (normalized !== undefined) pushWord(normalized);
	}
	return out;
}

/** Parse `QI_FILTER_BANNED_WORDS`-style toggles: 0/false/no/off disable, 1/true/yes/on enable. */
export function parseFilterToggle(value: string | undefined): boolean | undefined {
	if (value === undefined) return undefined;
	switch (value.trim().toLowerCase()) {
		case "1":
		case "true":
		case "yes":
		case "on":
			return true;
		case "0":
		case "false":
		case "no":
		case "off":
			return false;
		default:
			return undefined;
	}
}
