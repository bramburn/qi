import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { scrubAmbientPiEnv } from "./harness.ts";

// Leaked before any hook runs, the way a developer's shell (or a pi session
// running the suite) exports these. The harness must scrub it.
process.env.PI_SUMMARIZER_MODEL = "leaked at import time";

describe("harness ambient PI_* isolation", () => {
	// Deliberately not in afterEach: the leaked value has to survive into the next
	// test so "scrubs again before each following test" can observe the re-scrub.
	afterAll(() => {
		delete process.env.PI_SUMMARIZER_MODEL;
	});

	afterEach(() => {
		delete process.env.PI_MODEL;
		delete process.env.PILOT_MODE;
		delete process.env.PIZZA_TOPPING;
	});

	it("scrubs PI_* that leaked in before any test ran", () => {
		expect(process.env.PI_SUMMARIZER_MODEL).toBeUndefined();
		// Re-leak it so the next test can prove the scrub runs per test, not once.
		process.env.PI_SUMMARIZER_MODEL = "leaked by the previous test";
	});

	it("scrubs again before each following test", () => {
		expect(process.env.PI_SUMMARIZER_MODEL).toBeUndefined();
	});

	it("deletes the PI_ family but keeps PI_OFFLINE and non-PI names", () => {
		process.env.PI_MODEL = "leaked";
		process.env.PI_SUMMARIZER_MODEL = "leaked";
		process.env.PI_OFFLINE = "1";
		// Near misses: "PILOT_MODE" starts with PI but not "PI_", "PIZZA_TOPPING"
		// is unrelated. Neither belongs to the family under test.
		process.env.PILOT_MODE = "keep";
		process.env.PIZZA_TOPPING = "keep";

		scrubAmbientPiEnv();

		expect(process.env.PI_MODEL).toBeUndefined();
		expect(process.env.PI_SUMMARIZER_MODEL).toBeUndefined();
		// PI_OFFLINE is the vitest config's network guard; scrubbing it would let
		// tests reach the real API.
		expect(process.env.PI_OFFLINE).toBe("1");
		expect(process.env.PILOT_MODE).toBe("keep");
		expect(process.env.PIZZA_TOPPING).toBe("keep");
	});

	// Nested so the hook below only covers its own test. It registers after the
	// harness scrub (root-level hooks run first), so the value it sets has to
	// survive into the test body — suite tests rely on that when they set
	// PI_TEST_ANALYTICS_HOME or PI_OFFLINE themselves and restore them later.
	describe("env a test sets in its own hooks", () => {
		beforeEach(() => {
			process.env.PI_SUMMARIZER_MODEL = "set by the test's own hook";
		});

		it("wins over the scrub", () => {
			expect(process.env.PI_SUMMARIZER_MODEL).toBe("set by the test's own hook");
		});
	});
});
