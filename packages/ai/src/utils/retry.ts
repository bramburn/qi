import type { AssistantMessage } from "../types.ts";

function buildProviderErrorPattern(patterns: readonly string[]): RegExp {
	return new RegExp(patterns.join("|"), "i");
}

const NON_RETRYABLE_PROVIDER_LIMIT_ERROR_PATTERN = buildProviderErrorPattern([
	// OpenCode Go/free-tier limits returned as 429 JSON error types by OpenCode's
	// Zen API. These are subscription/account limits, not transient throttles.
	"GoUsageLimitError",
	"FreeUsageLimitError",

	// OpenCode Go subscription-limit text asks users to enable available-balance
	// usage after rolling/weekly/monthly limits are reached.
	"Monthly usage limit reached",
	"available balance",

	// Generic quota/budget/billing exhaustion. `insufficient_quota` is OpenAI's
	// quota/billing error code; the other strings cover common gateway wording.
	"insufficient_quota",
	"out of budget",
	"quota exceeded",
	"billing",
]);

const RETRYABLE_PROVIDER_ERROR_PATTERN = buildProviderErrorPattern([
	// Generic provider load, HTTP status, and server-side transient failures.
	"overloaded",
	"rate.?limit",
	"too many requests",
	"429",
	"500",
	"502",
	"503",
	"504",
	"524",
	"service.?unavailable",
	"server.?error",
	"internal.?error",

	// Wrapper/provider text for transient upstream failures, including OpenRouter
	// "Provider returned error" responses (#2264).
	"provider.?returned.?error",
	"exceeded request buffer limit while retrying upstream",

	// Network, proxy, and fetch transport failures. This includes OpenAI Codex
	// raw-fetch failures such as "upstream connect", "connection refused", and
	// "reset before headers" (#733), plus OpenRouter connection drops (#3317).
	"network.?error",
	"connection.?error",
	"connection.?refused",
	"connection.?lost",
	"other side closed",
	"fetch failed",
	"getaddrinfo",
	"ENOTFOUND",
	"EAI_AGAIN",
	"upstream.?connect",
	"reset before headers",
	"socket hang up",
	"socket connection was closed",
	"timed? out",
	"timeout",
	"terminated",

	// WebSocket transports can report close/error text instead of HTTP/fetch text.
	"websocket.?closed",
	"websocket.?error",

	// Premature stream endings from SDKs and transports. Anthropic can throw
	// "stream ended without ..." and "Anthropic stream ended before message_stop"
	// (#4433); Bedrock/Smithy can throw an HTTP/2 no-response error (#3594).
	"ended without",
	"stream ended before message_stop",
	"stream ended before a terminal response event",
	"http2 request did not get a response",

	// Provider-requested retry delay cap failures should flow through the outer
	// retry policy so callers can surface/abort the backoff (#1123).
	"retry delay",

	// Explicit retry guidance emitted mid-stream by OpenAI Responses and Bedrock
	// stream exceptions (#6019).
	"you can retry your request",
	"try your request again",
	"please retry your request",

	// gRPC based providers (e.g. NVIDIA NIM)
	"ResourceExhausted",
]);

/**
 * Retry policy: bounded attempts with exponential backoff (`baseDelayMs * 2^(attempt-1)`).
 * Matches `settings.retry` (`enabled`, `maxRetries`, `baseDelayMs`) in coding-agent; kept
 * here so the classifier and the policy-driven retry loop live together and stay reusable
 * by the SDK and other callers.
 */
export interface RetryPolicy {
	enabled: boolean;
	/** Max retry attempts (0 = no retries). The initial call never counts as a retry. */
	maxRetries: number;
	/** Base delay in ms. Per-attempt delay is `baseDelayMs * 2^(attempt-1)` before jitter. */
	baseDelayMs: number;
	/** Optional cap in ms for the computed backoff (including `Retry-After`). Defaults to `DEFAULT_MAX_BACKOFF_DELAY_MS`. */
	maxDelayMs?: number;
}

/**
 * Non-retryable billing/account exhaustion. These signals mean the account itself
 * cannot pay for or is barred from the request, so retrying would only burn
 * context and hammer the endpoint. Checked before any rate-limit classification.
 */
const PERMANENT_QUOTA_PATTERNS: readonly RegExp[] = [
	/\binsufficient_quota\b/i,
	/\bbilling_hard_limit_reached\b/i,
	/\bcredit balance is too low\b/i,
	/\bplan and billing details\b/i,
	/\baccount (?:is )?(?:suspended|deactivated|disabled)\b/i,
];

/**
 * Returns true for non-retryable billing/account exhaustion that should never
 * be retried (as opposed to transient 429 rate limits, which are retryable).
 */
export function isPermanentQuotaErrorMessage(errorMessage: string | undefined): boolean {
	if (!errorMessage) return false;
	return PERMANENT_QUOTA_PATTERNS.some((pattern) => pattern.test(errorMessage));
}

/**
 * HTTP 429 and provider rate-limit signals (TPM/RPM/concurrency throttles),
 * including server-requested retry delays. Permanent quota/billing exhaustion
 * is excluded via {@link isPermanentQuotaErrorMessage}.
 */
const RATE_LIMIT_PATTERNS: readonly RegExp[] = [
	/\b429\b/,
	/\brate[ _-]?limit(?:ed|_error|_exceeded)?\b/i,
	/\btoo many requests\b/i,
	/\btokens per min(?:ute)?\b/i,
	/\brequests per min(?:ute)?\b/i,
	/\b(?:tpm|rpm)\b.*?\b(?:limit|exceeded|rate)\b/i,
	/\bthrottl(?:ed|ing|ingexception)\b/i,
	/\btoomanyrequestsexception\b/i,
	/\bresource_exhausted\b/i,
	/\bquota exceeded for quota metric\b/i,
	/\bserver requested \d+(?:\.\d+)?s retry delay\b/i,
];

/**
 * Returns true for HTTP 429 / provider rate-limit errors (including TPM/RPM
 * token-limit messages that also mention token counts). Permanent
 * quota/billing exhaustion is never a rate limit.
 */
export function isRateLimitErrorMessage(errorMessage: string | undefined): boolean {
	if (!errorMessage) return false;
	if (isPermanentQuotaErrorMessage(errorMessage)) return false;
	return RATE_LIMIT_PATTERNS.some((pattern) => pattern.test(errorMessage));
}

/**
 * Returns true when a failed assistant turn ended in a 429 / rate-limit error.
 * Used to keep failed rate-limited turns out of context history, token
 * estimation, and compaction triggers.
 */
export function isRateLimitAssistantError(
	message: Pick<AssistantMessage, "stopReason" | "errorMessage"> | undefined,
): boolean {
	if (!message || message.stopReason !== "error") return false;
	return isRateLimitErrorMessage(message.errorMessage);
}

/**
 * Parse a server-requested retry backoff from response headers or error text.
 * Checks `retry-after-ms`, then `retry-after` (seconds or an HTTP date), then
 * human/machine phrasing in the message (`try again in 4.5s`, `retry in 500ms`,
 * `retryDelay:"15s"`). Returns undefined when no usable delay is present.
 */
export function parseRetryAfterMs(
	errorMessage?: string,
	headers?: Headers | Record<string, string | undefined>,
): number | undefined {
	const getHeader = (name: string): string | undefined => {
		if (!headers) return undefined;
		if (typeof (headers as Headers).get === "function") {
			return (headers as Headers).get(name) ?? undefined;
		}
		const record = headers as Record<string, string | undefined>;
		const foundKey = Object.keys(record).find((k) => k.toLowerCase() === name.toLowerCase());
		return foundKey ? record[foundKey] : undefined;
	};
	const retryAfterMsHeader = getHeader("retry-after-ms");
	if (retryAfterMsHeader) {
		const ms = Number.parseFloat(retryAfterMsHeader);
		if (Number.isFinite(ms) && ms > 0) return Math.ceil(ms);
	}
	const retryAfterHeader = getHeader("retry-after");
	if (retryAfterHeader) {
		const seconds = Number.parseFloat(retryAfterHeader);
		if (Number.isFinite(seconds) && seconds > 0) {
			return Math.ceil(seconds * 1000);
		}
		const dateMs = Date.parse(retryAfterHeader);
		if (!Number.isNaN(dateMs)) {
			const delta = dateMs - Date.now();
			if (delta > 0) return Math.ceil(delta);
		}
	}
	if (errorMessage) {
		// e.g. "Please try again in 12.5s", "Please retry in 500ms", "retry after 30 seconds", "retryDelay":"15s"
		const msMatch = /\b(?:try again in|retry (?:in|after)|retryDelay["':\s]+)\s*(\d+(?:\.\d+)?)\s*ms\b/i.exec(
			errorMessage,
		);
		if (msMatch?.[1]) {
			const ms = Number.parseFloat(msMatch[1]);
			if (Number.isFinite(ms) && ms > 0) return Math.ceil(ms);
		}
		const secMatch =
			/\b(?:try again in|retry (?:in|after)|retry_after["':\s]+|retryDelay["':\s]+|Server requested\s+)\s*(\d+(?:\.\d+)?)\s*(?:s|sec|seconds)\b/i.exec(
				errorMessage,
			);
		if (secMatch?.[1]) {
			const sec = Number.parseFloat(secMatch[1]);
			if (Number.isFinite(sec) && sec > 0) return Math.ceil(sec * 1000);
		}
	}
	return undefined;
}

export interface ExponentialBackoffOptions {
	/** 1-indexed (attempt 1 = first retry). */
	attempt: number;
	baseDelayMs: number;
	maxDelayMs?: number;
	retryAfterMs?: number;
	isRateLimit?: boolean;
	/** Fraction of the capped exponential added as positive jitter. Default 0.2. */
	jitterRatio?: number;
	random?: () => number;
}

/** Floor applied to positive base delays for rate-limit backoff so 429s always breathe. */
export const DEFAULT_RATE_LIMIT_MIN_BASE_DELAY_MS = 2_000;
/** Default cap for a single computed backoff sleep. */
export const DEFAULT_MAX_BACKOFF_DELAY_MS = 60_000;

/**
 * Exponential backoff: `effectiveBase * 2^(attempt-1)`, capped, jittered, and
 * raised to `retryAfterMs` when the server asked for a longer delay.
 * `baseDelayMs <= 0` stays at 0 (deterministic fast unit tests) unless
 * `retryAfterMs` explicitly requests a wait.
 */
export function computeExponentialBackoffMs(options: ExponentialBackoffOptions): number {
	const {
		attempt,
		baseDelayMs,
		maxDelayMs = DEFAULT_MAX_BACKOFF_DELAY_MS,
		retryAfterMs,
		isRateLimit = false,
		jitterRatio = 0.2,
		random = Math.random,
	} = options;
	// Preserve baseDelayMs === 0 for deterministic zero-delay unit tests unless retryAfterMs is explicitly set
	const effectiveBase =
		baseDelayMs <= 0 ? 0 : isRateLimit ? Math.max(baseDelayMs, DEFAULT_RATE_LIMIT_MIN_BASE_DELAY_MS) : baseDelayMs;
	const exponent = Math.max(0, attempt - 1);
	const rawExponential = effectiveBase * 2 ** exponent;
	const cappedExponential = maxDelayMs > 0 ? Math.min(rawExponential, maxDelayMs) : rawExponential;
	const jitter = cappedExponential > 0 && jitterRatio > 0 ? Math.floor(cappedExponential * jitterRatio * random()) : 0;
	const exponentialWithJitter = cappedExponential + jitter;
	if (retryAfterMs !== undefined && retryAfterMs > 0) {
		return Math.max(exponentialWithJitter, retryAfterMs);
	}
	return exponentialWithJitter;
}

/** Optional callbacks emitted by {@link retryAssistantCall} around each retry. */
export interface RetryCallbacks {
	/** Emitted before the backoff sleep of each retry attempt (1-indexed). */
	onRetryScheduled?: (
		attempt: number,
		maxAttempts: number,
		delayMs: number,
		errorMessage: string,
	) => void | Promise<void>;
	/** Emitted after the backoff sleep, immediately before the retried call starts. */
	onRetryAttemptStart?: () => void | Promise<void>;
	/** Emitted once when the loop ends: success if a later call completed normally. */
	onRetryFinished?: (success: boolean, attempt: number, finalError?: string) => void | Promise<void>;
}

class RetrySleepAbortError extends Error {
	constructor() {
		super("Aborted");
	}
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(new RetrySleepAbortError());
			return;
		}
		const timeout = setTimeout(resolve, ms);
		signal?.addEventListener(
			"abort",
			() => {
				clearTimeout(timeout);
				reject(new RetrySleepAbortError());
			},
			{ once: true },
		);
	});
}

/**
 * Run a single assistant-producing call with bounded retry on transient errors.
 *
 * Behavior:
 * - A successful response is returned immediately. Aborts are terminal and never
 *   retried, but reported as unsuccessful if they happen after a retry was scheduled.
 *   Aborts during the backoff sleep are normalized to an aborted `AssistantMessage`
 *   too, so callers do not need to care when cancellation happened.
 * - A non-retryable error (per {@link isRetryableAssistantError}, including quota/
 *   billing exhaustion) is returned immediately so deterministic errors fail fast.
 * - Otherwise retries up to `maxRetries` times with exponential backoff, emitting
 *   `onRetryScheduled` before each sleep, `onRetryAttemptStart` after each sleep before
 *   the retried call starts, and `onRetryFinished` once at the end (whether the loop
 *   ends in success, exhausted retries, or an aborted backoff).
 *
 * When `policy` is undefined or disabled, the first response is returned unchanged
 * (equivalent to calling `produce()` directly).
 */
export async function retryAssistantCall(
	produce: () => Promise<AssistantMessage>,
	policy: RetryPolicy | undefined,
	signal: AbortSignal | undefined,
	callbacks?: RetryCallbacks,
): Promise<AssistantMessage> {
	const maxAttempts = policy?.enabled ? policy.maxRetries : 0;

	let attempt = 0;
	let lastRetry: { attempt: number; errorMessage: string } | undefined;
	for (;;) {
		const response = await produce();

		// Abort: terminal but not successful. Never retry an aborted message.
		if (response.stopReason === "aborted") {
			if (lastRetry) await callbacks?.onRetryFinished?.(false, lastRetry.attempt);
			return response;
		}

		// Success: non-error, non-abort responses return as-is.
		if (response.stopReason !== "error") {
			if (lastRetry) await callbacks?.onRetryFinished?.(true, lastRetry.attempt);
			return response;
		}

		// Non-retryable, or budget exhausted: return the final error message.
		if (attempt >= maxAttempts || !isRetryableAssistantError(response)) {
			if (lastRetry) await callbacks?.onRetryFinished?.(false, lastRetry.attempt, response.errorMessage);
			return response;
		}

		attempt++;
		lastRetry = { attempt, errorMessage: response.errorMessage || "Unknown error" };
		// Honor server-requested backoff and give 429/rate-limit errors a
		// breathing floor; jitter spreads synchronized clients. baseDelayMs 0
		// stays deterministic for fast unit tests unless Retry-After says otherwise.
		const activePolicy = policy as RetryPolicy;
		const isRateLimit = isRateLimitErrorMessage(response.errorMessage);
		const retryAfterMs = parseRetryAfterMs(response.errorMessage);
		const delayMs = computeExponentialBackoffMs({
			attempt,
			baseDelayMs: activePolicy.baseDelayMs,
			maxDelayMs: activePolicy.maxDelayMs ?? DEFAULT_MAX_BACKOFF_DELAY_MS,
			retryAfterMs,
			isRateLimit,
			jitterRatio: activePolicy.baseDelayMs > 0 ? 0.2 : 0,
		});
		await callbacks?.onRetryScheduled?.(attempt, maxAttempts, delayMs, lastRetry.errorMessage);

		// Normalize aborts during retry backoff to the same AssistantMessage shape as
		// provider stream aborts, so callers do not need to care when cancellation happened.
		try {
			await sleep(delayMs, signal);
		} catch (error) {
			await callbacks?.onRetryFinished?.(false, attempt, lastRetry.errorMessage);
			if (error instanceof RetrySleepAbortError) {
				return { ...response, stopReason: "aborted", errorMessage: undefined };
			}
			throw error;
		}
		await callbacks?.onRetryAttemptStart?.();
	}
}

/**
 * Classifies whether a failed assistant message looks like a transient provider
 * or transport error, so callers can decide if the last assistant turn should be
 * restarted.
 *
 * This does not implement retry policy. Callers should first handle context
 * overflow separately, then apply their own retry budget, backoff, and reporting
 * before restarting the assistant turn.
 */
export function isRetryableAssistantError(message: AssistantMessage): boolean {
	if (message.stopReason !== "error" || !message.errorMessage) return false;
	const errorMessage = message.errorMessage;
	// Permanent billing/account exhaustion never retries.
	if (isPermanentQuotaErrorMessage(errorMessage)) return false;
	// 429 / rate-limit errors (including TPM/RPM token-limit wording) retry
	// with exponential backoff, even when they mention token counts.
	if (isRateLimitErrorMessage(errorMessage)) return true;
	if (NON_RETRYABLE_PROVIDER_LIMIT_ERROR_PATTERN.test(errorMessage)) return false;
	return RETRYABLE_PROVIDER_ERROR_PATTERN.test(errorMessage);
}
