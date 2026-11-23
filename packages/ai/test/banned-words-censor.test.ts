import { afterEach, describe, expect, it } from "vitest";
import { transformMessages } from "../src/api/transform-messages.ts";
import type { AssistantMessage, Message, Model, TextContent, ToolResultMessage, UserMessage } from "../src/types.ts";
import {
	BANNED_WORDS_CENSOR_NOTICE,
	censorMessagesForLlm,
	censorSystemPromptForLlm,
	configureBannedWordsFilter,
	maskBannedWord,
} from "../src/utils/banned-words.ts";

const TEST_WORDS = ["FalunGong", "Falun Gong", "Tiananmen", "法轮功", "天安门", "法轮", "ab"];

afterEach(() => {
	configureBannedWordsFilter({ enabled: true, words: [] });
});

function makeModel(): Model<"anthropic-messages"> {
	return {
		id: "claude-sonnet-4.6",
		name: "Claude Sonnet 4.6",
		api: "anthropic-messages",
		provider: "anthropic",
		baseUrl: "https://api.anthropic.com",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200000,
		maxTokens: 8192,
	};
}

function makeAssistant(content: AssistantMessage["content"]): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4.6",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 0,
	};
}

function makeUser(content: UserMessage["content"]): UserMessage {
	return { role: "user", content, timestamp: 0 };
}

function makeToolResult(text: string): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: "call_1",
		toolName: "search",
		content: [{ type: "text", text }],
		isError: false,
		timestamp: 0,
	};
}

describe("maskBannedWord", () => {
	it("keeps first and last code point for length >= 3", () => {
		expect(maskBannedWord("FalunGong")).toBe("F*******g");
		expect(maskBannedWord("Tiananmen")).toBe("T*******n");
		expect(maskBannedWord("法轮功")).toBe("法*功");
		expect(maskBannedWord("天安门")).toBe("天*门");
	});
	it("inserts an asterisk for 2-code-point words so nothing survives verbatim", () => {
		expect(maskBannedWord("法轮")).toBe("法*轮");
	});
	it("replaces a single code point with a single asterisk", () => {
		expect(maskBannedWord("a")).toBe("*");
	});
	it("handles astral-plane code points without splitting surrogate pairs", () => {
		expect(maskBannedWord("a\u{1F600}b")).toBe("a*b");
		expect(maskBannedWord("\u{1F600}\u{1F601}")).toBe("\u{1F600}*\u{1F601}");
		expect(maskBannedWord("")).toBe("");
	});
});

describe("censorMessagesForLlm", () => {
	it("censors user string content and appends the one-line notice once", () => {
		const messages: Message[] = [makeUser("entries 125412->125340 fts(FalunGong)=0")];
		const out = censorMessagesForLlm(messages, { words: TEST_WORDS });
		expect(out).not.toBe(messages);
		expect(out[0]).not.toBe(messages[0]);
		const content = (out[0] as UserMessage).content as string;
		expect(content).toContain("fts(F*******g)=0");
		expect(content).not.toContain("FalunGong");
		expect(content).toContain(BANNED_WORDS_CENSOR_NOTICE);
		expect(content.split(BANNED_WORDS_CENSOR_NOTICE).length - 1).toBe(1);
	});

	it("censors TextContent blocks, toolResult output, thinking, and toolCall arguments", () => {
		const messages: Message[] = [
			makeUser([{ type: "text", text: "what about 天安门 square?" } satisfies TextContent]),
			makeAssistant([
				{ type: "text", text: "saw FalunGong in output" } satisfies TextContent,
				{ type: "thinking", thinking: "thinking about Tiananmen" },
			]),
			makeToolResult("entries 125412->125340 flagged=190 fts(FalunGong)=0 fts(Tiananmen,benign)=6"),
			makeAssistant([
				{
					type: "toolCall",
					id: "1",
					name: "run",
					arguments: { cmd: "grep FalunGong files" },
				},
			]),
		];
		configureBannedWordsFilter({ enabled: true, words: TEST_WORDS });
		const out = censorMessagesForLlm(messages);
		expect((out[0] as UserMessage).content).toEqual([{ type: "text", text: "what about 天*门 square?" }]);
		const a0 = out[1] as AssistantMessage;
		expect(a0.content[0]).toMatchObject({ type: "text", text: "saw F*******g in output" });
		expect(a0.content[1]).toMatchObject({ type: "thinking", thinking: "thinking about T*******n" });
		expect((out[2] as ToolResultMessage).content[0]).toMatchObject({
			type: "text",
			text: expect.stringContaining("fts(F*******g)=0 fts(T*******n,benign)=6"),
		});
		const a1 = out[3] as AssistantMessage;
		expect(a1.content[0]).toMatchObject({
			type: "toolCall",
			arguments: { cmd: "grep F*******g files" },
		});
		// Notice appears exactly once across the whole history.
		const joined = JSON.stringify(out);
		expect(joined.split(BANNED_WORDS_CENSOR_NOTICE).length - 1).toBe(1);
		// Notice lands on the last censored user/toolResult message.
		expect(JSON.stringify(out[2])).toContain(BANNED_WORDS_CENSOR_NOTICE);
		expect(JSON.stringify(out[3])).not.toContain(BANNED_WORDS_CENSOR_NOTICE);
	});

	it("does not duplicate the notice when it is already present", () => {
		const messages: Message[] = [
			makeUser(`first FalunGong hit\n${BANNED_WORDS_CENSOR_NOTICE}`),
			makeUser("second Tiananmen hit"),
		];
		const out = censorMessagesForLlm(messages, { words: TEST_WORDS });
		const joined = JSON.stringify(out);
		expect(joined.split(BANNED_WORDS_CENSOR_NOTICE).length - 1).toBe(1);
		expect(JSON.stringify(out[1])).toContain("T*******n");
	});

	it("matches Latin terms case-insensitively and inside identifiers", () => {
		const messages: Message[] = [makeUser("fts(falungong)=0 and FALUNGONG again")];
		const out = censorMessagesForLlm(messages, { words: TEST_WORDS });
		const content = (out[0] as UserMessage).content as string;
		expect(content).toContain("fts(f*******g)=0");
		expect(content).toContain("F*******G");
	});

	it("prefers the longest match for overlapping terms", () => {
		const messages: Message[] = [makeUser("Falun Gong practitioners and 法轮功")];
		const out = censorMessagesForLlm(messages, { words: TEST_WORDS });
		const content = (out[0] as UserMessage).content as string;
		expect(content).toContain("F********g");
		expect(content).toContain("法*功");
		expect(content).not.toContain("法*轮");
	});

	it("preserves object references and adds no notice when nothing matches or disabled", () => {
		const messages: Message[] = [makeUser("clean text"), makeToolResult("clean output")];
		const out = censorMessagesForLlm(messages, { words: TEST_WORDS });
		expect(out).toBe(messages);
		expect(JSON.stringify(out)).not.toContain(BANNED_WORDS_CENSOR_NOTICE);
		const disabled = censorMessagesForLlm([makeUser("FalunGong here")], {
			words: TEST_WORDS,
			enabled: false,
		});
		expect(disabled[0]).toEqual(makeUser("FalunGong here"));
		expect(JSON.stringify(disabled)).not.toContain(BANNED_WORDS_CENSOR_NOTICE);
	});

	it("censorSystemPromptForLlm masks terms and returns the same reference when clean", () => {
		expect(censorSystemPromptForLlm("prompt about FalunGong", { words: TEST_WORDS })).toBe("prompt about F*******g");
		const clean = "entirely clean prompt";
		expect(censorSystemPromptForLlm(clean, { words: TEST_WORDS })).toBe(clean);
	});
});

describe("transformMessages banned-words integration", () => {
	it("censors outbound history and appends the notice for provider adapters", () => {
		configureBannedWordsFilter({ enabled: true, words: TEST_WORDS });
		const messages: Message[] = [makeUser("tool said fts(FalunGong)=0")];
		const out = transformMessages(messages, makeModel());
		const content = (out[0] as UserMessage).content as string;
		expect(content).toContain("F*******g");
		expect(content).toContain(BANNED_WORDS_CENSOR_NOTICE);
	});

	it("leaves clean histories untouched (no clone, no notice)", () => {
		configureBannedWordsFilter({ enabled: true, words: TEST_WORDS });
		const messages: Message[] = [makeUser("hello world")];
		const out = transformMessages(messages, makeModel());
		expect(out[0]).toBe(messages[0]);
		expect(JSON.stringify(out)).not.toContain(BANNED_WORDS_CENSOR_NOTICE);
	});
});
