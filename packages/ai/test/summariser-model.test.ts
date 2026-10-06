import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	PI_SUMMARIZER_API_KEY_ENV,
	PI_SUMMARIZER_BASE_URL_ENV,
	PI_SUMMARIZER_MAX_TOKENS_ENV,
	PI_SUMMARIZER_MODEL_ENV,
	PI_SUMMARIZER_THINKING_ENV,
} from "../src/summariser-env.ts";
import { resolveSummariserModel, SUMMARISER_OVERRIDE_PROVIDER_ID } from "../src/summariser-model.ts";

const ENV_KEYS = [
	PI_SUMMARIZER_BASE_URL_ENV,
	PI_SUMMARIZER_MODEL_ENV,
	PI_SUMMARIZER_API_KEY_ENV,
	PI_SUMMARIZER_MAX_TOKENS_ENV,
	PI_SUMMARIZER_THINKING_ENV,
] as const;

const originalEnv: Record<string, string | undefined> = {};

beforeEach(() => {
	for (const key of ENV_KEYS) originalEnv[key] = process.env[key];
	for (const key of ENV_KEYS) delete process.env[key];
	vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
	for (const key of ENV_KEYS) {
		const original = originalEnv[key];
		if (original === undefined) delete process.env[key];
		else process.env[key] = original;
	}
	vi.restoreAllMocks();
});

describe("resolveSummariserModel", () => {
	it("returns undefined when no PI_SUMMARIZER_* env vars are set (caller falls back to main model)", () => {
		expect(resolveSummariserModel()).toBeUndefined();
	});

	it("returns undefined when any required env var is missing", () => {
		process.env[PI_SUMMARIZER_BASE_URL_ENV] = "https://api.deepseek.com/v1";
		process.env[PI_SUMMARIZER_MODEL_ENV] = "deepseek-chat";
		// PI_SUMMARIZER_API_KEY intentionally not set
		expect(resolveSummariserModel()).toBeUndefined();
	});

	it("returns a Model<openai-completions> + apiKey when the three required vars are set", () => {
		process.env[PI_SUMMARIZER_BASE_URL_ENV] = "https://api.deepseek.com/v1";
		process.env[PI_SUMMARIZER_MODEL_ENV] = "deepseek-chat";
		process.env[PI_SUMMARIZER_API_KEY_ENV] = "sk-test";

		const result = resolveSummariserModel();
		expect(result).toBeDefined();
		expect(result?.apiKey).toBe("sk-test");
		expect(result?.model.api).toBe("openai-completions");
		expect(result?.model.id).toBe("deepseek-chat");
		expect(result?.model.baseUrl).toBe("https://api.deepseek.com/v1");
		expect(result?.model.provider).toBe(SUMMARISER_OVERRIDE_PROVIDER_ID);
		expect(result?.model.name).toBe("deepseek-chat (PI summariser override)");
		expect(result?.model.input).toEqual(["text"]);
		expect(result?.model.reasoning).toBe(false);
		expect(result?.model.contextWindow).toBe(256000);
		expect(result?.model.maxTokens).toBe(32768);
		expect(result?.model.cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
	});

	it("returns the same provider id on repeated calls so re-registration replaces in place", () => {
		process.env[PI_SUMMARIZER_BASE_URL_ENV] = "https://api.example.com/v1";
		process.env[PI_SUMMARIZER_MODEL_ENV] = "my-local-llm";
		process.env[PI_SUMMARIZER_API_KEY_ENV] = "sk-test";

		const first = resolveSummariserModel();
		const second = resolveSummariserModel();
		expect(second?.model.provider).toBe(first?.model.provider);
		expect(second?.model.provider).toBe(SUMMARISER_OVERRIDE_PROVIDER_ID);
	});

	it("omits maxTokens/thinking from the result when the optional env vars are unset", () => {
		process.env[PI_SUMMARIZER_BASE_URL_ENV] = "https://api.deepseek.com/v1";
		process.env[PI_SUMMARIZER_MODEL_ENV] = "deepseek-chat";
		process.env[PI_SUMMARIZER_API_KEY_ENV] = "sk-test";

		const result = resolveSummariserModel();
		expect(result).toBeDefined();
		expect(result?.maxTokens).toBeUndefined();
		expect(result?.thinking).toBeUndefined();
		expect(result?.model.maxTokens).toBe(32768);
		expect(result?.model.reasoning).toBe(false);
	});

	it("uses PI_SUMMARIZER_MAX_TOKENS as the model's output cap and passes it through", () => {
		process.env[PI_SUMMARIZER_BASE_URL_ENV] = "https://api.deepseek.com/v1";
		process.env[PI_SUMMARIZER_MODEL_ENV] = "deepseek-chat";
		process.env[PI_SUMMARIZER_API_KEY_ENV] = "sk-test";
		process.env[PI_SUMMARIZER_MAX_TOKENS_ENV] = "16384";

		const result = resolveSummariserModel();
		expect(result?.maxTokens).toBe(16384);
		expect(result?.model.maxTokens).toBe(16384);
	});

	it("enables the model's reasoning flag and passes thinking through when PI_SUMMARIZER_THINKING is set", () => {
		process.env[PI_SUMMARIZER_BASE_URL_ENV] = "https://api.deepseek.com/v1";
		process.env[PI_SUMMARIZER_MODEL_ENV] = "deepseek-chat";
		process.env[PI_SUMMARIZER_API_KEY_ENV] = "sk-test";
		process.env[PI_SUMMARIZER_THINKING_ENV] = "medium";

		const result = resolveSummariserModel();
		expect(result?.thinking).toBe("medium");
		expect(result?.model.reasoning).toBe(true);
	});

	it("keeps reasoning off when PI_SUMMARIZER_THINKING=off", () => {
		process.env[PI_SUMMARIZER_BASE_URL_ENV] = "https://api.deepseek.com/v1";
		process.env[PI_SUMMARIZER_MODEL_ENV] = "deepseek-chat";
		process.env[PI_SUMMARIZER_API_KEY_ENV] = "sk-test";
		process.env[PI_SUMMARIZER_THINKING_ENV] = "off";

		const result = resolveSummariserModel();
		expect(result?.thinking).toBeUndefined();
		expect(result?.model.reasoning).toBe(false);
	});
});
