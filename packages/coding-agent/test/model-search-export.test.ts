import { describe, expect, test } from "vitest";
import { getModelSearchText, getModelSelectorSearchText, type ModelSearchItem } from "../src/index.ts";

const item: ModelSearchItem = { id: "gpt-5", provider: "openai", name: "GPT-5" };

describe("model search exports", () => {
	test("exports the generic search text", () => {
		expect(getModelSearchText(item)).toBe("gpt-5 openai openai/gpt-5 openai gpt-5 GPT-5");
	});

	test("exports the selector search text", () => {
		expect(getModelSelectorSearchText(item)).toBe("openai openai/gpt-5 openai gpt-5 GPT-5");
	});

	test("keeps the bare id out of the leading position in the selector variant", () => {
		expect(getModelSelectorSearchText(item).startsWith("gpt-5 ")).toBe(false);
		expect(getModelSearchText(item).startsWith("gpt-5 ")).toBe(true);
	});

	test("omits the name segment when no name is set", () => {
		expect(getModelSelectorSearchText({ id: "x", provider: "p" })).toBe("p p/x p x");
	});
});
