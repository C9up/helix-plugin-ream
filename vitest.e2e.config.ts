import { defineConfig } from "vitest/config";

/**
 * `ream test` end to end: the real `ream` binary (`REAM_BIN`) against this
 * package. Kept out of `pnpm test`, which has no binary to run.
 */
export default defineConfig({
	test: {
		include: ["tests/e2e/**/*.test.ts"],
	},
});
