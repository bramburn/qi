import { describe, expect, it } from "vitest";
import { fauxAssistantMessage } from "../src/providers/faux.ts";
import { isContextOverflow } from "../src/utils/overflow.ts";
import {
	computeExponentialBackoffMs,
	DEFAULT_MAX_BACKOFF_DELAY_MS,
	DEFAULT_RATE_LIMIT_MIN_BASE_DELAY_MS,
	isPermanentQuotaErrorMessage,
	isRateLimitAssistantError,
	isRateLimitErrorMessage,
	isRetryableAssistantError,
	parseRetryAfterMs,
} from "../src/utils/retry.ts";

const TPM_429_MESSAGES = [
	"429 Rate limit reached for gpt-4o on tokens per min (TPM): Limit 30000, Used 25000, Requested 8000",
	"429 Request too large for model on tokens per minute",
	"429 Too Many Requests: token limit exceeded",
	"RESOURCE_EXHAUSTED: quota exceeded for tokens per minute",
	"429 Rate limit exceeded. Please try again in 4s",
	"ThrottlingException: Too many tokens, please wait before trying again.",
	"Rate limit reached for model on requests per minute",
	"tpm limit exceeded, retry after 30 seconds",
];

const GENUINE_OVERFLOW_MESSAGES = [
	"Your input exceeds the context window of this model",
	"Requested token count exceeds the model's maximum context length of 131072 tokens",
	"prompt is too long: 210000 tokens > 200000 maximum",
	"context_length_exceeded: maximum context length is 200000 tokens",
	"token limit exceeded for this model context window",
];

describe("429 rate-limit classification", () => {
	it("detects 429 / TPM / RPM / throttling errors as rate limits", () => {
		for (const errorMessage of TPM_429_MESSAGES) {
			expect(isRateLimitErrorMessage(errorMessage), errorMessage).toBe(true);
		}
	});

	it("excludes permanent quota/billing exhaustion from rate limits", () => {
		for (const errorMessage of [
			"insufficient_quota: you exceeded your current quota",
			"billing_hard_limit_reached",
			"Your credit balance is too low",
			"Please check your plan and billing details",
			"Your account is suspended for non-payment",
			"Account deactivated: contact support",
		]) {
			expect(isPermanentQuotaErrorMessage(errorMessage), errorMessage).toBe(true);
			expect(isRateLimitErrorMessage(errorMessage), errorMessage).toBe(false);
			expect(
				isRetryableAssistantError(fauxAssistantMessage("", { stopReason: "error", errorMessage })),
				errorMessage,
			).toBe(false);
		}
	});

	it("returns false for missing or unrelated messages", () => {
		expect(isRateLimitErrorMessage(undefined)).toBe(false);
		expect(isRateLimitErrorMessage("")).toBe(false);
		expect(isRateLimitErrorMessage("overloaded_error")).toBe(false);
		expect(isRateLimitErrorMessage("terminated")).toBe(false);
		expect(isPermanentQuotaErrorMessage(undefined)).toBe(false);
		expect(isRateLimitAssistantError(fauxAssistantMessage("not an error"))).toBe(false);
		expect(
			isRateLimitAssistantError(
				fauxAssistantMessage("", { stopReason: "aborted", errorMessage: "429 Too Many Requests" }),
			),
		).toBe(false);
		expect(isRateLimitAssistantError(undefined)).toBe(false);
	});

	it("classifies failed 429 assistant turns", () => {
		for (const errorMessage of TPM_429_MESSAGES) {
			const message = fauxAssistantMessage("", { stopReason: "error", errorMessage });
			expect(isRateLimitAssistantError(message), errorMessage).toBe(true);
			expect(isRetryableAssistantError(message), errorMessage).toBe(true);
		}
	});
});

describe("isContextOverflow 429 guard", () => {
	it("returns false for 429 TPM/RPM errors even when they mention token counts", () => {
		for (const errorMessage of TPM_429_MESSAGES) {
			const message = fauxAssistantMessage("", { stopReason: "error", errorMessage });
			expect(isContextOverflow(message), errorMessage).toBe(false);
			expect(isContextOverflow(message, 128_000), errorMessage).toBe(false);
		}
	});

	it("still returns true for genuine 400/413 context overflow errors", () => {
		for (const errorMessage of GENUINE_OVERFLOW_MESSAGES) {
			const message = fauxAssistantMessage("", { stopReason: "error", errorMessage });
			expect(isContextOverflow(message), errorMessage).toBe(true);
		}
	});
});

describe("parseRetryAfterMs", () => {
	it("extracts delays from retry-after-ms headers", () => {
		expect(parseRetryAfterMs(undefined, { "retry-after-ms": "250" })).toBe(250);
		expect(parseRetryAfterMs("boom", new Headers({ "retry-after-ms": "250" }))).toBe(250);
	});

	it("extracts delays from retry-after seconds headers", () => {
		expect(parseRetryAfterMs(undefined, { "retry-after": "2" })).toBe(2000);
		expect(parseRetryAfterMs(undefined, new Headers({ "Retry-After": "1.5" }))).toBe(1500);
	});

	it("extracts delays from error message text", () => {
		expect(parseRetryAfterMs("Please try again in 4.5s")).toBe(4500);
		expect(parseRetryAfterMs("Please retry in 500ms")).toBe(500);
		expect(parseRetryAfterMs('{"retryDelay":"15s"}')).toBe(15000);
		expect(parseRetryAfterMs("Server requested 12s retry delay")).toBe(12000);
	});

	it("returns undefined when no usable delay is present", () => {
		expect(parseRetryAfterMs(undefined)).toBeUndefined();
		expect(parseRetryAfterMs("boom")).toBeUndefined();
		expect(parseRetryAfterMs(undefined, { "retry-after": "0" })).toBeUndefined();
	});
});

describe("computeExponentialBackoffMs", () => {
	const noJitter = () => 0;

	it("applies exponential doubling per attempt", () => {
		expect(computeExponentialBackoffMs({ attempt: 1, baseDelayMs: 1000, random: noJitter })).toBe(1000);
		expect(computeExponentialBackoffMs({ attempt: 2, baseDelayMs: 1000, random: noJitter })).toBe(2000);
		expect(computeExponentialBackoffMs({ attempt: 3, baseDelayMs: 1000, random: noJitter })).toBe(4000);
	});

	it("enforces the 2000ms minimum base floor for rate limits when baseDelayMs > 0", () => {
		expect(DEFAULT_RATE_LIMIT_MIN_BASE_DELAY_MS).toBe(2000);
		expect(computeExponentialBackoffMs({ attempt: 1, baseDelayMs: 100, isRateLimit: true, random: noJitter })).toBe(
			2000,
		);
		expect(computeExponentialBackoffMs({ attempt: 2, baseDelayMs: 100, isRateLimit: true, random: noJitter })).toBe(
			4000,
		);
	});

	it("preserves 0 delay when baseDelayMs is 0 for fast unit tests", () => {
		expect(computeExponentialBackoffMs({ attempt: 1, baseDelayMs: 0, random: noJitter })).toBe(0);
		expect(computeExponentialBackoffMs({ attempt: 5, baseDelayMs: 0, isRateLimit: true, random: noJitter })).toBe(0);
	});

	it("respects retryAfterMs when larger than the computed exponential delay", () => {
		expect(computeExponentialBackoffMs({ attempt: 1, baseDelayMs: 1000, retryAfterMs: 5000, random: noJitter })).toBe(
			5000,
		);
		expect(computeExponentialBackoffMs({ attempt: 1, baseDelayMs: 0, retryAfterMs: 300, random: noJitter })).toBe(
			300,
		);
		expect(
			computeExponentialBackoffMs({
				attempt: 1,
				baseDelayMs: 1000,
				retryAfterMs: 500,
				jitterRatio: 0,
				random: noJitter,
			}),
		).toBe(1000);
	});

	it("caps the delay at maxDelayMs and adds positive jitter", () => {
		expect(computeExponentialBackoffMs({ attempt: 10, baseDelayMs: 1000, maxDelayMs: 3000, random: noJitter })).toBe(
			3000,
		);
		expect(DEFAULT_MAX_BACKOFF_DELAY_MS).toBe(60_000);
		expect(computeExponentialBackoffMs({ attempt: 1, baseDelayMs: 1000, jitterRatio: 0.2, random: () => 1 })).toBe(
			1200,
		);
	});
});
