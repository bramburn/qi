import type { AssistantMessage } from "@bramburn/qi-ai";
import { fauxAssistantMessage } from "@bramburn/qi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHarness, type Harness } from "../harness.ts";

/**
 * Regression: HTTP 429 / rate-limit errors must not consume context window,
 * trigger (threshold or overflow) compaction, or hammer the endpoint.
 *
 * - Failed 429 turns are never persisted to the session tree or retained in
 *   agent state, so they add no tokens and never advance the leaf id.
 * - A 429-terminated turn never runs overflow auto-compaction or post-turn
 *   threshold background compaction (even when 429 payload token counts push
 *   the estimate over the threshold).
 * - Retries of 429 errors honor `Retry-After` via exponential backoff and a
 *   per-provider cooldown gate delays the next request until the window ends.
 */
describe("429 backoff without context bloat or compaction", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
		vi.useRealTimers();
	});

	function rateLimitError(errorMessage: string): AssistantMessage {
		return fauxAssistantMessage("", { stopReason: "error", errorMessage });
	}

	it("does not persist 429 responses and recovers on retry", async () => {
		const harness = await createHarness({ settings: { retry: { enabled: true, maxRetries: 2, baseDelayMs: 0 } } });
		harnesses.push(harness);
		harness.setResponses([
			rateLimitError("429 Too Many Requests: Rate limit reached on tokens per min (TPM)"),
			rateLimitError("429 Too Many Requests: Rate limit reached on tokens per min (TPM)"),
			fauxAssistantMessage("recovered answer"),
		]);

		await harness.session.prompt("hello");

		expect(harness.session.getLastAssistantText()).toBe("recovered answer");
		expect(harness.faux.state.callCount).toBe(3);
		// No failed 429 turn may remain in the in-memory context window ...
		const errorAssistants = harness.session.agent.state.messages.filter(
			(message): message is AssistantMessage =>
				message.role === "assistant" && (message as AssistantMessage).stopReason === "error",
		);
		expect(errorAssistants).toHaveLength(0);
		// ... nor be persisted to the session tree (leaf id must not advance on 429s).
		const persistedErrors = harness.sessionManager
			.getEntries()
			.filter(
				(entry) =>
					entry.type === "message" &&
					entry.message.role === "assistant" &&
					(entry.message as AssistantMessage).stopReason === "error",
			);
		expect(persistedErrors).toHaveLength(0);
		// Context accounting reflects only the valid messages.
		const usage = harness.session.getContextUsage();
		expect(usage?.tokens).not.toBeNull();
	});

	it("never runs auto-compaction or threshold compaction on a 429 turn", async () => {
		for (const retry of [
			{ enabled: false, maxRetries: 2, baseDelayMs: 0 },
			{ enabled: true, maxRetries: 1, baseDelayMs: 0 },
		]) {
			let compactionHookCalls = 0;
			const harness = await createHarness({
				settings: { compaction: { enabled: true }, retry },
				extensionFactories: [
					(pi) => {
						pi.on("session_before_compact", () => {
							compactionHookCalls++;
						});
					},
				],
			});
			harnesses.push(harness);

			// Seed usage just under the threshold (contextWindow 128000 -
			// reserveTokens 16384 = 111616) so the user message still fits,
			// but the 429 error payload would push the estimate over it.
			const model = harness.getModel();
			const usage = {
				input: 111550,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 111550,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			};
			harness.sessionManager.appendMessage({
				role: "user",
				content: [{ type: "text", text: "seed" }],
				timestamp: Date.now() - 1000,
			});
			harness.sessionManager.appendMessage({
				...fauxAssistantMessage("seeded context", { stopReason: "stop", timestamp: Date.now() - 500 }),
				api: model.api,
				provider: model.provider,
				model: model.id,
				usage,
			});
			harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;

			// This payload mentions token counts and TPM limits: before the fix,
			// `isContextOverflow` matched "token limit exceeded" and fired
			// overflow auto-compaction against the custom compaction model.
			const failures = [
				rateLimitError(
					"429 Request too large for model on tokens per minute (TPM): token limit exceeded (Limit 30000, Requested 35000)",
				),
			];
			if (retry.enabled) {
				failures.push(
					rateLimitError(
						"429 Request too large for model on tokens per minute (TPM): token limit exceeded (Limit 30000, Requested 35000)",
					),
				);
			}
			harness.setResponses(failures);

			await harness.session.prompt("x".repeat(200));
			// Let any background compaction launch settle (it emits compaction_start synchronously).
			await new Promise((resolve) => setTimeout(resolve, 10));

			expect(harness.eventsOfType("compaction_start")).toHaveLength(0);
			expect(compactionHookCalls).toBe(0);
			expect(harness.sessionManager.getEntries().filter((entry) => entry.type === "compaction")).toHaveLength(0);
			expect(harness.faux.state.callCount).toBe(retry.enabled ? 2 : 1);
		}
	});

	it("backs off with Retry-After and holds the provider cooldown before retrying", async () => {
		vi.useFakeTimers();
		const harness = await createHarness({
			settings: { retry: { enabled: true, maxRetries: 2, baseDelayMs: 1000 } },
		});
		harnesses.push(harness);
		harness.setResponses([
			rateLimitError("429 Rate limit exceeded. Please retry in 4s"),
			fauxAssistantMessage("recovered"),
		]);

		const promptPromise = harness.session.prompt("hello");
		await vi.advanceTimersByTimeAsync(0);
		expect(harness.faux.state.callCount).toBe(1);
		// The server asked for a 4s delay: the retry must not fire early.
		await vi.advanceTimersByTimeAsync(3999);
		expect(harness.faux.state.callCount).toBe(1);
		await vi.advanceTimersByTimeAsync(1);
		await promptPromise;

		expect(harness.faux.state.callCount).toBe(2);
		expect(harness.session.getLastAssistantText()).toBe("recovered");
		const starts = harness.eventsOfType("auto_retry_start");
		expect(starts).toHaveLength(1);
		expect(starts[0]).toMatchObject({ attempt: 1, delayMs: 4000 });
	});
});
