/**
 * Regression: superseded edit collapse (deepseekHarness.collapseSupersededEdits).
 *
 * Contract:
 * - Gated on both `deepseekHarness.enabled` and
 *   `deepseekHarness.collapseSupersededEdits`.
 * - Deterministic: repeated successful edits to the same file collapse to
 *   stubs in the outgoing provider context, except the last edit of a closed
 *   group and every edit in the still-open most recent group.
 * - Context-only: every message, toolCall, and toolResult stays in place and
 *   paired; only the toolCall arguments and the paired toolResult text change.
 * - Failed edits are kept verbatim.
 */
import type { AgentTool } from "@bramburn/qi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@bramburn/qi-ai/compat";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { COLLAPSED_EDIT_NOTE } from "../../../src/core/compaction/edit-history-collapse.ts";
import { createHarness, type Harness } from "../harness.ts";

type CapturedContext = Awaited<ReturnType<typeof runEditScript>>;

const editTool: AgentTool = {
	name: "edit",
	label: "Edit",
	description: "Apply targeted replacements to a file",
	parameters: Type.Object({
		path: Type.String(),
		edits: Type.Array(Type.Object({ oldText: Type.String(), newText: Type.String() })),
	}),
	execute: async () => ({
		content: [{ type: "text" as const, text: "Successfully replaced 1 block(s)" }],
		details: undefined,
	}),
};

function editCall(id: string, path: string): ReturnType<typeof fauxAssistantMessage> {
	return fauxAssistantMessage(
		fauxToolCall(
			"edit",
			{
				path,
				edits: [{ oldText: "before".repeat(400), newText: "after".repeat(400) }],
			},
			{ id },
		),
		{ stopReason: "toolUse" },
	);
}

async function runEditScript(harness: Harness): Promise<{
	messages: Array<{
		role: string;
		toolCallId?: string;
		toolName?: string;
		content?: unknown;
	}>;
	calls: Array<{ id: string; arguments: Record<string, unknown> }>;
}> {
	let lastContext:
		| {
				messages: Array<{
					role: string;
					toolCallId?: string;
					toolName?: string;
					content?: unknown;
				}>;
		  }
		| undefined;
	harness.setResponses([
		editCall("call-a1", "src/a.ts"),
		editCall("call-a2", "src/a.ts"),
		editCall("call-a3", "src/a.ts"),
		editCall("call-b1", "src/b.ts"),
		(context) => {
			lastContext = context as unknown as typeof lastContext;
			return fauxAssistantMessage("done");
		},
	]);

	await harness.session.prompt("edit the files");

	const messages = lastContext?.messages ?? [];
	const calls: Array<{ id: string; arguments: Record<string, unknown> }> = [];
	for (const message of messages) {
		if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
		for (const block of message.content as Array<Record<string, unknown>>) {
			if (block.type === "toolCall" && block.name === "edit") {
				calls.push({ id: String(block.id), arguments: block.arguments as Record<string, unknown> });
			}
		}
	}
	return { messages, calls };
}

function assertPairedAndOrdered(captured: CapturedContext): void {
	const ids = captured.calls.map((call) => call.id);
	expect(ids).toEqual(["call-a1", "call-a2", "call-a3", "call-b1"]);

	const resultIds = captured.messages
		.filter((message) => message.role === "toolResult")
		.map((message) => message.toolCallId);
	expect(resultIds).toEqual(ids);
}

describe("regression #011: collapse superseded edit calls", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("collapses earlier closed-group edits, keeps the last edit and later files, and preserves pairing", async () => {
		const harness = await createHarness({
			tools: [editTool],
			settings: {
				deepseekHarness: { enabled: true, collapseSupersededEdits: true, editCollapseThresholdChars: 100 },
			},
		});
		harnesses.push(harness);

		const captured = await runEditScript(harness);
		assertPairedAndOrdered(captured);

		const [a1, a2, a3, b1] = captured.calls;
		expect(a1?.arguments.collapsed).toBe(true);
		expect(a2?.arguments.collapsed).toBe(true);
		expect(a3?.arguments.collapsed).toBeUndefined();
		expect(b1?.arguments.collapsed).toBeUndefined();

		const fullAEdits = captured.calls.filter(
			(call) => call.arguments.path === "src/a.ts" && call.arguments.collapsed !== true,
		);
		expect(fullAEdits).toHaveLength(1);
		expect(fullAEdits[0]?.id).toBe("call-a3");

		const collapsedResults = captured.messages.filter(
			(message) =>
				message.role === "toolResult" &&
				Array.isArray(message.content) &&
				(message.content as Array<Record<string, unknown>>).some((block) => block.text === COLLAPSED_EDIT_NOTE),
		);
		expect(collapsedResults.map((message) => message.toolCallId)).toEqual(["call-a1", "call-a2"]);

		// Persisted session history is untouched.
		const persistedCalls: string[] = [];
		for (const message of harness.session.messages) {
			if (message.role !== "assistant") continue;
			for (const block of message.content) {
				if (block.type === "toolCall" && block.name === "edit") persistedCalls.push(block.id);
			}
			expect(JSON.stringify(message)).not.toContain("collapsed");
		}
		expect(persistedCalls).toEqual(["call-a1", "call-a2", "call-a3", "call-b1"]);
	});

	it("leaves provider messages untouched when the bundle is off", async () => {
		const harness = await createHarness({
			tools: [editTool],
			settings: {
				deepseekHarness: { enabled: false, collapseSupersededEdits: true, editCollapseThresholdChars: 100 },
			},
		});
		harnesses.push(harness);

		const captured = await runEditScript(harness);
		assertPairedAndOrdered(captured);
		expect(captured.calls.every((call) => call.arguments.collapsed === undefined)).toBe(true);
	});

	it("leaves provider messages untouched when the collapse setting is off", async () => {
		const harness = await createHarness({
			tools: [editTool],
			settings: {
				deepseekHarness: { enabled: true, collapseSupersededEdits: false, editCollapseThresholdChars: 100 },
			},
		});
		harnesses.push(harness);

		const captured = await runEditScript(harness);
		assertPairedAndOrdered(captured);
		expect(captured.calls.every((call) => call.arguments.collapsed === undefined)).toBe(true);
	});
});
