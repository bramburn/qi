import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	clearBannedWordsCache,
	ENV_BANNED_WORDS_PATH,
	ENV_FILTER_BANNED_WORDS,
	loadBannedWords,
	splitEnvPathList,
} from "../src/core/banned-words-loader.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";

let tempDir: string;

beforeEach(() => {
	tempDir = mkdtempSync(join(tmpdir(), "qi-banned-words-test-"));
	clearBannedWordsCache();
	delete process.env[ENV_BANNED_WORDS_PATH];
	delete process.env[ENV_FILTER_BANNED_WORDS];
});

afterEach(() => {
	delete process.env[ENV_BANNED_WORDS_PATH];
	delete process.env[ENV_FILTER_BANNED_WORDS];
	if (tempDir) {
		rmSync(tempDir, { recursive: true, force: true });
	}
});

function writeBannedVocabSqlite(path: string): void {
	const db = new DatabaseSync(path);
	db.exec(
		"CREATE TABLE banned(id INTEGER PRIMARY KEY, simp TEXT, trad TEXT, pinyin TEXT," +
			" pinyin_num TEXT, gloss TEXT, hsk INTEGER, freq_rank INTEGER," +
			" action TEXT, reason TEXT, archived_date TEXT)",
	);
	const insert = db.prepare(
		"INSERT INTO banned(id,simp,trad,pinyin,pinyin_num,gloss,hsk,freq_rank,action,reason,archived_date)" +
			" VALUES(?,?,?,?,?,?,?,?,?,?,?)",
	);
	insert.run(1, "法轮功", "法輪功", "fa lun gong", "fa3 lun2 gong1", "banned gloss", null, null, "remove", "r", "d");
	insert.run(2, "天安门", "天安門", "tian an men", null, "other gloss", null, null, "remove", "r", "d");
	db.exec("CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT)");
	db.close();
}

describe("loadBannedWords", () => {
	it("extracts simp/trad terms from a hanzi-dict style banned_vocab.sqlite", () => {
		const dbPath = join(tempDir, "banned_vocab.sqlite");
		writeBannedVocabSqlite(dbPath);
		const words = loadBannedWords({ configuredPaths: [dbPath], includeWellKnownPaths: false });
		expect(words).toContain("法轮功");
		expect(words).toContain("法輪功");
		expect(words).toContain("天安门");
		expect(words).toContain("天安門");
		// Gloss sentences and pinyin must not leak in as censored terms.
		expect(words).not.toContain("banned gloss");
		expect(words).not.toContain("fa lun gong");
	});

	it("always includes the base latin aliases even with no sources", () => {
		const words = loadBannedWords({ includeWellKnownPaths: false });
		expect(words).toEqual(["FalunGong", "Falun Gong", "Tiananmen"]);
		const wordsFromFile = loadBannedWords({ configuredPaths: [], includeWellKnownPaths: false });
		expect(wordsFromFile).toEqual(words);
	});

	it("loads political_remove entries from banned_vocab.json excluding reviewed-visible terms", () => {
		const jsonPath = join(tempDir, "banned_vocab.json");
		writeFileSync(
			jsonPath,
			JSON.stringify({
				political_remove: { entries: ["法轮功", "Tiananmen"] },
				explicit_gate: { entries: ["妓女"] },
				reviewed_visible: { denylist: ["妓女"], benign_no_audio: ["自由港"] },
			}),
		);
		const words = loadBannedWords({ configuredPaths: [jsonPath], includeWellKnownPaths: false });
		expect(words).toContain("法轮功");
		expect(words).toContain("Tiananmen");
		expect(words).not.toContain("妓女");
		expect(words).not.toContain("自由港");
	});

	it("loads plain text/CSV lists, directories, and inline words with dedupe", () => {
		const listPath = join(tempDir, "words.txt");
		writeFileSync(listPath, "FalunGong\nTiananmen, 法轮功\nFalunGong\n");
		const words = loadBannedWords({
			configuredPaths: [listPath],
			inlineWords: ["tiananmen", " extra "],
			includeWellKnownPaths: false,
		});
		expect(words).toContain("FalunGong");
		expect(words).toContain("Tiananmen");
		expect(words).toContain("法轮功");
		expect(words).toContain("extra");
		expect(words.filter((w) => w.toLowerCase() === "falungong")).toHaveLength(1);
		expect(words.filter((w) => w.toLowerCase() === "tiananmen")).toHaveLength(1);
	});

	it("splits QI_BANNED_WORDS_PATH and skips missing paths", () => {
		const dbPath = join(tempDir, "banned_vocab.sqlite");
		writeBannedVocabSqlite(dbPath);
		// `;`-separated, with a missing entry skipped; drive-letter colons kept.
		expect(splitEnvPathList(`${dbPath};/does/not/exist.sqlite`)).toEqual([dbPath, "/does/not/exist.sqlite"]);
		const words = loadBannedWords({
			envPathList: `${dbPath};/does/not/exist.sqlite`,
			includeWellKnownPaths: false,
		});
		expect(words).toContain("法轮功");
		// POSIX-style `:`-separated relative entries.
		expect(splitEnvPathList("a.sqlite:b.json")).toEqual(["a.sqlite", "b.json"]);
	});
});

describe("SettingsManager banned-words settings", () => {
	it("defaults getFilterBannedWords() to true", () => {
		mkdirSync(join(tempDir, "agent"), { recursive: true });
		const settingsManager = SettingsManager.create(tempDir, join(tempDir, "agent"));
		expect(settingsManager.getFilterBannedWords()).toBe(true);
	});

	it("respects filterBannedWords: false and QI_FILTER_BANNED_WORDS", () => {
		mkdirSync(join(tempDir, "agent"), { recursive: true });
		const settingsManager = SettingsManager.create(tempDir, join(tempDir, "agent"));
		settingsManager.setFilterBannedWords(false);
		expect(settingsManager.getFilterBannedWords()).toBe(false);
		process.env[ENV_FILTER_BANNED_WORDS] = "0";
		expect(settingsManager.getFilterBannedWords()).toBe(false);
		process.env[ENV_FILTER_BANNED_WORDS] = "1";
		expect(settingsManager.getFilterBannedWords()).toBe(true);
		settingsManager.setFilterBannedWords(true);
		process.env[ENV_FILTER_BANNED_WORDS] = "no";
		expect(settingsManager.getFilterBannedWords()).toBe(false);
	});

	it("merges settings bannedWordsPath with QI_BANNED_WORDS_PATH", () => {
		mkdirSync(join(tempDir, "agent"), { recursive: true });
		const settingsManager = SettingsManager.create(tempDir, join(tempDir, "agent"));
		expect(settingsManager.getBannedWordsPaths()).toEqual([]);
		settingsManager.setBannedWordsPath([join(tempDir, "a.sqlite")]);
		process.env[ENV_BANNED_WORDS_PATH] = join(tempDir, "b.json");
		expect(settingsManager.getBannedWordsPaths()).toEqual([join(tempDir, "a.sqlite"), join(tempDir, "b.json")]);
		settingsManager.appendBannedWordsPaths([join(tempDir, "c.txt")]);
		expect(settingsManager.getBannedWordsPaths()).toEqual([
			join(tempDir, "a.sqlite"),
			join(tempDir, "c.txt"),
			join(tempDir, "b.json"),
		]);
		expect(settingsManager.getBannedWords()).toEqual([]);
		settingsManager.setBannedWords(["ZedWord"]);
		expect(settingsManager.getBannedWords()).toEqual(["ZedWord"]);
	});
});
