import { join } from "node:path";
import type { AgentMessage } from "@bramburn/qi-agent-core";
import type { AssistantMessage, TextContent, ThinkingContent, ToolCall, ToolResultMessage } from "@bramburn/qi-ai";
import { describe, expect, it } from "vitest";
import {
	COLLAPSED_EDIT_NOTE,
	collapseSupersededEdits,
	DEFAULT_EDIT_COLLAPSE_THRESHOLD_CHARS,
	type EditCollapseOptions,
} from "../src/core/compaction/edit-history-collapse.ts";

const CWD = process.cwd();
const OPTIONS: EditCollapseOptions = { thresholdChars: 0 };

function editArgs(path: string, oldText = "before", newText = "after"): Record<string, unknown> {
	return { path, edits: [{ oldText, newText }] };
}

function assistantToolCalls(
	id: string,
	path: string,
	blocks: Array<TextContent | ThinkingContent | ToolCall> = [],
): AssistantMessage {
	const toolCall: ToolCall = { type: "toolCall", id, name: "edit", arguments: editArgs(path) };
	return {
		role: "assistant",
		content: [...blocks, toolCall],
		api: "faux",
		provider: "faux",
		model: "faux-1",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "toolUse",
		timestamp: 1,
	};
}

function toolResult(id: string, isError = false): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: id,
		toolName: "edit",
		content: [{ type: "text", text: isError ? "Error: edit failed" : "Successfully replaced 1 block(s)" }],
		isError,
		timestamp: 1,
	};
}

function userMessage(text: string): AgentMessage {
	return { role: "user", content: text, timestamp: 1 };
}

function editGroup(id: string, path: string): AgentMessage[] {
	return [assistantToolCalls(id, path), toolResult(id)];
}

function toolCallBlocks(messages: AgentMessage[]): ToolCall[] {
	const calls: ToolCall[] = [];
	for (const message of messages) {
		if (message.role !== "assistant") continue;
		for (const block of message.content) {
			if (block.type === "toolCall") calls.push(block);
		}
	}
	return calls;
}

function toolResultText(messages: AgentMessage[], id: string): string | undefined {
	const result = messages.find(
		(message): message is ToolResultMessage => message.role === "toolResult" && message.toolCallId === id,
	);
	const block = result?.content[0];
	return block?.type === "text" ? block.text : undefined;
}

function deepFreeze<T>(value: T): T {
	if (value && typeof value === "object" && !Object.isFrozen(value)) {
		Object.freeze(value);
		for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
	}
	return value;
}

describe("collapseSupersededEdits", () => {
	it("stubs earlier edits in a closed group and keeps the last one plus later edits", () => {
		const messages: AgentMessage[] = [
			...editGroup("a1", "src/a.ts"),
			...editGroup("a2", "src/a.ts"),
			...editGroup("a3", "src/a.ts"),
			...editGroup("b1", "src/b.ts"),
		];

		const out = collapseSupersededEdits(messages, CWD, OPTIONS);

		expect(out).toHaveLength(messages.length);
		const calls = toolCallBlocks(out);
		expect(calls.map((call) => call.id)).toEqual(["a1", "a2", "a3", "b1"]);
		expect(calls[0]?.arguments.collapsed).toBe(true);
		expect(calls[1]?.arguments.collapsed).toBe(true);
		expect(calls[2]?.arguments.collapsed).toBeUndefined();
		expect(calls[2]?.arguments.edits).toEqual([{ oldText: "before", newText: "after" }]);
		expect(calls[3]?.arguments.collapsed).toBeUndefined();
		expect(toolResultText(out, "a1")).toBe(COLLAPSED_EDIT_NOTE);
		expect(toolResultText(out, "a2")).toBe(COLLAPSED_EDIT_NOTE);
		expect(toolResultText(out, "a3")).toBe("Successfully replaced 1 block(s)");
		expect(toolResultText(out, "b1")).toBe("Successfully replaced 1 block(s)");
	});

	it("never collapses the most recent group", () => {
		const messages: AgentMessage[] = [
			...editGroup("a1", "src/a.ts"),
			...editGroup("a2", "src/a.ts"),
			...editGroup("a3", "src/a.ts"),
		];

		expect(collapseSupersededEdits(messages, CWD, OPTIONS)).toBe(messages);
	});

	it("leaves failed edits and their toolCalls untouched", () => {
		const messages: AgentMessage[] = [
			...editGroup("a1", "src/a.ts"),
			assistantToolCalls("failed", "src/a.ts"),
			toolResult("failed", true),
			...editGroup("a3", "src/a.ts"),
			...editGroup("b1", "src/b.ts"),
		];

		const out = collapseSupersededEdits(messages, CWD, OPTIONS);

		const calls = toolCallBlocks(out);
		expect(calls.find((call) => call.id === "a1")?.arguments.collapsed).toBe(true);
		expect(calls.find((call) => call.id === "failed")?.arguments.collapsed).toBeUndefined();
		expect(calls.find((call) => call.id === "a3")?.arguments.collapsed).toBeUndefined();
		expect(toolResultText(out, "failed")).toBe("Error: edit failed");
	});

	it("breaks a group at a user message", () => {
		const messages: AgentMessage[] = [
			...editGroup("a1", "src/a.ts"),
			...editGroup("a2", "src/a.ts"),
			userMessage("please continue"),
			...editGroup("a3", "src/a.ts"),
			...editGroup("a4", "src/a.ts"),
		];

		const out = collapseSupersededEdits(messages, CWD, OPTIONS);

		const calls = toolCallBlocks(out);
		expect(calls.find((call) => call.id === "a1")?.arguments.collapsed).toBe(true);
		expect(calls.find((call) => call.id === "a2")?.arguments.collapsed).toBeUndefined();
		expect(calls.find((call) => call.id === "a3")?.arguments.collapsed).toBeUndefined();
		expect(calls.find((call) => call.id === "a4")?.arguments.collapsed).toBeUndefined();
	});

	it("does not collapse a group below the threshold", () => {
		const messages: AgentMessage[] = [
			...editGroup("a1", "src/a.ts"),
			...editGroup("a2", "src/a.ts"),
			...editGroup("b1", "src/b.ts"),
		];

		expect(collapseSupersededEdits(messages, CWD, { thresholdChars: DEFAULT_EDIT_COLLAPSE_THRESHOLD_CHARS })).toBe(
			messages,
		);
	});

	it("canonicalises relative, dot-relative, and absolute paths into one group", () => {
		const absolute = join(CWD, "src/a.ts");
		const messages: AgentMessage[] = [
			assistantToolCalls("a1", "src/a.ts"),
			toolResult("a1"),
			assistantToolCalls("a2", "./src/a.ts"),
			toolResult("a2"),
			assistantToolCalls("a3", absolute),
			toolResult("a3"),
			...editGroup("b1", "src/b.ts"),
		];

		const out = collapseSupersededEdits(messages, CWD, OPTIONS);
		const calls = toolCallBlocks(out);

		expect(calls.find((call) => call.id === "a1")?.arguments.collapsed).toBe(true);
		expect(calls.find((call) => call.id === "a2")?.arguments.collapsed).toBe(true);
		expect(calls.find((call) => call.id === "a3")?.arguments.collapsed).toBeUndefined();
	});

	it("is idempotent and returns the same reference when there is nothing to do", () => {
		const messages: AgentMessage[] = [
			...editGroup("a1", "src/a.ts"),
			...editGroup("a2", "src/a.ts"),
			...editGroup("a3", "src/a.ts"),
			...editGroup("b1", "src/b.ts"),
		];

		const once = collapseSupersededEdits(messages, CWD, OPTIONS);
		const twice = collapseSupersededEdits(once, CWD, OPTIONS);

		expect(twice).toEqual(once);
		expect(twice).toBe(once);
	});

	it("does not mutate the input array or nested objects", () => {
		const messages = deepFreeze([
			...editGroup("a1", "src/a.ts"),
			...editGroup("a2", "src/a.ts"),
			...editGroup("b1", "src/b.ts"),
		]);

		expect(() => collapseSupersededEdits(messages as AgentMessage[], CWD, OPTIONS)).not.toThrow();
	});

	it("handles parallel tool calls in one assistant message and preserves thinking blocks", () => {
		const thinking: ThinkingContent = { type: "thinking", thinking: "reasoning stays" };
		const parallel = assistantToolCalls("a2", "src/a.ts", [thinking]);
		parallel.content = [
			thinking,
			{ type: "toolCall", id: "a1", name: "edit", arguments: editArgs("src/a.ts") },
			{ type: "toolCall", id: "a2", name: "edit", arguments: editArgs("src/a.ts") },
		];
		const messages: AgentMessage[] = [
			assistantToolCalls("a0", "src/a.ts"),
			toolResult("a0"),
			parallel,
			toolResult("a1"),
			toolResult("a2"),
			...editGroup("b1", "src/b.ts"),
		];

		const out = collapseSupersededEdits(messages, CWD, OPTIONS);

		const outParallel = out.find(
			(message): message is AssistantMessage =>
				message.role === "assistant" &&
				message.content.some((block) => block.type === "toolCall" && block.id === "a2"),
		);
		expect(outParallel?.content[0]).toBe(thinking);
		const calls = toolCallBlocks(out);
		expect(calls.find((call) => call.id === "a1")?.arguments.collapsed).toBe(true);
		expect(calls.find((call) => call.id === "a2")?.arguments.collapsed).toBeUndefined();
	});

	it("collapses legacy top-level oldText/newText arguments", () => {
		const makeLegacy = (id: string): AgentMessage => ({
			role: "assistant",
			content: [
				{
					type: "toolCall",
					id,
					name: "edit",
					arguments: { path: "src/a.ts", oldText: "before", newText: "after" },
				},
			],
			api: "faux",
			provider: "faux",
			model: "faux-1",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "toolUse",
			timestamp: 1,
		});
		const messages: AgentMessage[] = [
			makeLegacy("a1"),
			toolResult("a1"),
			makeLegacy("a2"),
			toolResult("a2"),
			...editGroup("b1", "src/b.ts"),
		];

		const out = collapseSupersededEdits(messages, CWD, OPTIONS);
		const calls = toolCallBlocks(out);

		expect(calls.find((call) => call.id === "a1")?.arguments.collapsed).toBe(true);
		expect(calls.find((call) => call.id === "a2")?.arguments.collapsed).toBeUndefined();
	});
});
