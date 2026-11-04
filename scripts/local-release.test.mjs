import assert from "node:assert/strict";
import test from "node:test";
import { resolveSpawnCommand } from "./local-release.mjs";

test("win32 runs ./test.sh through bash", () => {
	assert.deepEqual(resolveSpawnCommand("./test.sh", ["--skip-build"], "win32"), {
		command: "bash",
		args: ["./test.sh", "--skip-build"],
		shell: false,
	});
});

test("win32 runs any .sh script through bash", () => {
	assert.deepEqual(resolveSpawnCommand("./scripts/build-binaries.sh", ["--platform", "windows-x64"], "win32"), {
		command: "bash",
		args: ["./scripts/build-binaries.sh", "--platform", "windows-x64"],
		shell: false,
	});
});

test("win32 runs the npm shim through cmd.exe explicitly", () => {
	assert.deepEqual(resolveSpawnCommand("npm", ["run", "check"], "win32"), {
		command: "cmd.exe",
		args: ["/d", "/s", "/c", "npm.cmd", "run", "check"],
		shell: false,
	});
});

test("linux and darwin invoke ./test.sh directly", () => {
	for (const platform of ["linux", "darwin"]) {
		assert.deepEqual(resolveSpawnCommand("./test.sh", [], platform), {
			command: "./test.sh",
			args: [],
			shell: false,
		});
	}
});

test("a normal executable is not rewritten", () => {
	for (const platform of ["win32", "linux", "darwin"]) {
		assert.deepEqual(resolveSpawnCommand("git", ["status"], platform), {
			command: "git",
			args: ["status"],
			shell: false,
		});
	}
});