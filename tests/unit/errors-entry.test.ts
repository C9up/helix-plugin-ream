import { Exception } from "@c9up/flare";
import { describe, expect, it } from "vitest";
import { errors } from "../../src/index.js";
import { errors as runnerErrors } from "../../src/runTests.js";

describe("the errors namespace", () => {
	it("is exported from the entry, one flare Exception per code", () => {
		const error = new errors.E_HELIX_PLUGIN_REAM_NO_SERVER();
		expect(error).toBeInstanceOf(Exception);
		expect(error).toBeInstanceOf(errors.E_HELIX_PLUGIN_REAM_NO_SERVER);
		expect(error.code).toBe("E_HELIX_PLUGIN_REAM_NO_SERVER");
		expect(error.status).toBe(500);
		expect(error.message).toMatch(/neither/);
	});

	it("is the same namespace from the runner entry", () => {
		expect(runnerErrors.E_HELIX_PLUGIN_REAM_UNKNOWN_SUITE).toBe(
			errors.E_HELIX_PLUGIN_REAM_UNKNOWN_SUITE,
		);
		const error = new runnerErrors.E_HELIX_PLUGIN_REAM_UNKNOWN_SUITE([
			"e2e",
			". Declared: unit.",
		]);
		expect(error.message).toBe('Unknown test suite "e2e". Declared: unit.');
	});
});
