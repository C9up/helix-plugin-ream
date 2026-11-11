import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		// `ream test` end to end needs a built `ream` binary: it runs on its own,
		// through vitest.e2e.config.ts, where a missing piece is a failure.
		exclude: [...configDefaults.exclude, "tests/e2e/**"],
		coverage: {
			provider: "v8",
			include: ["src/**"],
			exclude: ["src/**/*.d.ts"],
			reporter: ["text-summary", "json-summary"],
			thresholds: {
				lines: 85,
				statements: 85,
				branches: 80,
				functions: 85,
			},
		},
	},
});
