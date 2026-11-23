import type {
	AssistantMessage,
	Message,
	TextContent,
	ThinkingContent,
	ToolCall,
	ToolResultMessage,
	UserMessage,
} from "../types.ts";

/**
 * One-line notice appended to the outbound message history whenever banned
 * words are censored. It tells the model that asterisk-masked tokens are
 * censored words without repeating any raw term.
 */
export const BANNED_WORDS_CENSOR_NOTICE =
	"Note: Some restricted words in this history have been censored with asterisks (keeping only the first and last character); please consider those as censored words.";

export interface BannedWordsFilterConfig {
	/** Whether banned-word censoring is enabled before sending to LLM providers. Default: true. */
	enabled: boolean;
	/** List of banned words/phrases to mask. */
	words: readonly string[];
	/** Optional custom one-line notice appended to history when censoring occurs. */
	notice?: string;
}

interface CompiledBannedFilter {
	enabled: boolean;
	notice: string;
	regex: RegExp | null;
}

let activeFilterConfig: BannedWordsFilterConfig = {
	enabled: true,
	words: [],
	notice: BANNED_WORDS_CENSOR_NOTICE,
};

let compiledFilter: CompiledBannedFilter = {
	enabled: true,
	notice: BANNED_WORDS_CENSOR_NOTICE,
	regex: null,
};

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isAsciiWordOnly(value: string): boolean {
	return /^[\x20-\x7E]+$/.test(value);
}

function compileBannedWordsRegex(words: readonly string[]): RegExp | null {
	const cleaned = Array.from(
		new Set(
			words
				.map((w) => w.trim())
				.filter((w) => {
					const len = Array.from(w).length;
					if (len === 0) return false;
					if (len === 1 && isAsciiWordOnly(w)) return false;
					return true;
				}),
		),
	);
	if (cleaned.length === 0) {
		return null;
	}
	// Longest terms first so longer phrases win over shorter substrings.
	cleaned.sort((a, b) => Array.from(b).length - Array.from(a).length);
	const patterns = cleaned.map((word) => {
		const escaped = escapeRegExp(word);
		const charLen = Array.from(word).length;
		if (isAsciiWordOnly(word) && charLen <= 3 && /^\w+$/.test(word)) {
			return `\\b${escaped}\\b`;
		}
		return escaped;
	});
	return new RegExp(`(?:${patterns.join("|")})`, "giu");
}

/**
 * Masks a single matched banned word with asterisks while keeping only the
 * first and last Unicode code point. Two-code-point words keep both with an
 * asterisk inserted so the term never survives verbatim; a single code point
 * becomes "*".
 */
export function maskBannedWord(word: string): string {
	const chars = Array.from(word);
	if (chars.length === 0) return word;
	if (chars.length === 1) return "*";
	if (chars.length === 2) return `${chars[0]}*${chars[1]}`;
	return `${chars[0]}${"*".repeat(chars.length - 2)}${chars[chars.length - 1]}`;
}

export function configureBannedWordsFilter(config: Partial<BannedWordsFilterConfig>): void {
	const enabled = config.enabled ?? activeFilterConfig.enabled;
	const words = config.words ?? activeFilterConfig.words;
	const notice = config.notice?.trim() || BANNED_WORDS_CENSOR_NOTICE;
	activeFilterConfig = { enabled, words: [...words], notice };
	compiledFilter = {
		enabled,
		notice,
		regex: enabled ? compileBannedWordsRegex(words) : null,
	};
}

export function getBannedWordsFilterConfig(): BannedWordsFilterConfig {
	return activeFilterConfig;
}

export interface CensorTextResult {
	text: string;
	censored: boolean;
}

export function censorBannedText(
	text: string,
	customWords?: readonly string[],
	enabledOverride?: boolean,
): CensorTextResult {
	const enabled = enabledOverride ?? compiledFilter.enabled;
	if (!enabled || !text) {
		return { text, censored: false };
	}
	const regex = customWords ? compileBannedWordsRegex(customWords) : compiledFilter.regex;
	if (!regex) {
		return { text, censored: false };
	}
	let censored = false;
	const nextText = text.replace(regex, (match) => {
		censored = true;
		return maskBannedWord(match);
	});
	return censored ? { text: nextText, censored: true } : { text, censored: false };
}

/**
 * Censors a system prompt for outbound LLM requests. Returns the same string
 * reference when nothing was censored.
 */
export function censorSystemPromptForLlm(
	systemPrompt: string,
	options?: { enabled?: boolean; words?: readonly string[] },
): string {
	const res = censorBannedText(systemPrompt, options?.words, options?.enabled);
	return res.text;
}

function censorUnknownValue(
	value: unknown,
	customWords?: readonly string[],
	enabledOverride?: boolean,
): { value: unknown; censored: boolean } {
	if (typeof value === "string") {
		const res = censorBannedText(value, customWords, enabledOverride);
		return { value: res.text, censored: res.censored };
	}
	if (Array.isArray(value)) {
		let anyCensored = false;
		const nextArr = value.map((item) => {
			const res = censorUnknownValue(item, customWords, enabledOverride);
			if (res.censored) anyCensored = true;
			return res.value;
		});
		return anyCensored ? { value: nextArr, censored: true } : { value, censored: false };
	}
	if (value !== null && typeof value === "object") {
		let anyCensored = false;
		const nextObj: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
			const res = censorUnknownValue(v, customWords, enabledOverride);
			if (res.censored) anyCensored = true;
			nextObj[k] = res.value;
		}
		return anyCensored ? { value: nextObj, censored: true } : { value, censored: false };
	}
	return { value, censored: false };
}

function messageContainsNotice(message: Message, notice: string): boolean {
	if (message.role === "user") {
		if (typeof message.content === "string") {
			return message.content.includes(notice);
		}
		return message.content.some((b) => b.type === "text" && b.text.includes(notice));
	}
	if (message.role === "toolResult") {
		return message.content.some((b) => b.type === "text" && b.text.includes(notice));
	}
	if (message.role === "assistant") {
		return message.content.some((b) => b.type === "text" && b.text.includes(notice));
	}
	return false;
}

function appendNoticeToMessage(message: Message, notice: string): Message {
	if (message.role === "user") {
		if (typeof message.content === "string") {
			return { ...message, content: `${message.content}\n${notice}` };
		}
		const content = [...message.content];
		for (let i = content.length - 1; i >= 0; i--) {
			const block = content[i];
			if (block.type === "text") {
				content[i] = { ...block, text: `${block.text}\n${notice}` };
				return { ...message, content };
			}
		}
		content.push({ type: "text", text: notice });
		return { ...message, content };
	}
	if (message.role === "toolResult") {
		const content = [...message.content];
		for (let i = content.length - 1; i >= 0; i--) {
			const block = content[i];
			if (block.type === "text") {
				content[i] = { ...block, text: `${block.text}\n${notice}` };
				return { ...message, content };
			}
		}
		content.push({ type: "text", text: notice });
		return { ...message, content };
	}
	return message;
}

/**
 * Censors banned words across all messages in a conversation history. If any
 * word is censored, appends a one-line notice once in the history (on the
 * last censored user/toolResult message). Preserves object references when
 * no banned words are matched.
 */
export function censorMessagesForLlm(
	messages: Message[],
	options?: { enabled?: boolean; words?: readonly string[]; notice?: string },
): Message[] {
	const enabled = options?.enabled ?? compiledFilter.enabled;
	if (!enabled) {
		return messages;
	}
	const customWords = options?.words;
	const regex = customWords ? compileBannedWordsRegex(customWords) : compiledFilter.regex;
	if (!regex) {
		return messages;
	}
	const notice = options?.notice?.trim() || compiledFilter.notice;
	let anyMessageCensored = false;
	let lastCensoredNoticeTargetIndex = -1;
	let lastFallbackNoticeTargetIndex = -1;
	let noticeAlreadyPresent = false;
	const nextMessages = messages.map((msg, index): Message => {
		if (messageContainsNotice(msg, notice)) {
			noticeAlreadyPresent = true;
		}
		if (msg.role === "user" || msg.role === "toolResult") {
			lastFallbackNoticeTargetIndex = index;
		}
		if (msg.role === "user") {
			if (typeof msg.content === "string") {
				const res = censorBannedText(msg.content, customWords, enabled);
				if (!res.censored) return msg;
				anyMessageCensored = true;
				lastCensoredNoticeTargetIndex = index;
				return { ...msg, content: res.text } satisfies UserMessage;
			}
			let blockChanged = false;
			const nextContent = msg.content.map((block) => {
				if (block.type !== "text") return block;
				const res = censorBannedText(block.text, customWords, enabled);
				if (!res.censored) return block;
				blockChanged = true;
				return { ...block, text: res.text } satisfies TextContent;
			});
			if (!blockChanged) return msg;
			anyMessageCensored = true;
			lastCensoredNoticeTargetIndex = index;
			return { ...msg, content: nextContent } satisfies UserMessage;
		}
		if (msg.role === "toolResult") {
			let blockChanged = false;
			const nextContent = msg.content.map((block) => {
				if (block.type !== "text") return block;
				const res = censorBannedText(block.text, customWords, enabled);
				if (!res.censored) return block;
				blockChanged = true;
				return { ...block, text: res.text } satisfies TextContent;
			});
			if (!blockChanged) return msg;
			anyMessageCensored = true;
			lastCensoredNoticeTargetIndex = index;
			return { ...msg, content: nextContent } satisfies ToolResultMessage;
		}
		if (msg.role === "assistant") {
			let blockChanged = false;
			const nextContent = msg.content.map((block) => {
				if (block.type === "text") {
					const res = censorBannedText(block.text, customWords, enabled);
					if (!res.censored) return block;
					blockChanged = true;
					return { ...block, text: res.text } satisfies TextContent;
				}
				if (block.type === "thinking") {
					if (block.redacted) return block;
					const res = censorBannedText(block.thinking, customWords, enabled);
					if (!res.censored) return block;
					blockChanged = true;
					return { ...block, thinking: res.text } satisfies ThinkingContent;
				}
				if (block.type === "toolCall") {
					const argsRes = censorUnknownValue(block.arguments, customWords, enabled);
					if (!argsRes.censored) return block;
					blockChanged = true;
					return {
						...block,
						arguments: argsRes.value as Record<string, unknown>,
					} satisfies ToolCall;
				}
				return block;
			});
			if (!blockChanged) return msg;
			anyMessageCensored = true;
			return { ...msg, content: nextContent } satisfies AssistantMessage;
		}
		return msg;
	});
	if (!anyMessageCensored) {
		return messages;
	}
	if (!noticeAlreadyPresent) {
		const targetIndex =
			lastCensoredNoticeTargetIndex !== -1 ? lastCensoredNoticeTargetIndex : lastFallbackNoticeTargetIndex;
		if (targetIndex !== -1) {
			nextMessages[targetIndex] = appendNoticeToMessage(nextMessages[targetIndex]!, notice);
		}
	}
	return nextMessages;
}
