/**
 * `ream test`'s filters and tuning flags, end to end: the real `ream` binary
 * parses them and hands them to `runTestsFromRcFile`, which has to apply each
 * one to helix — a filter narrows the run, `--timeout` / `--retries` override
 * the configured values, `--failed` replays the last failures, `--watch`
 * re-runs on a change.
 *
 * Not part of `pnpm test`: it needs a built `ream` binary, so it runs on its
 * own (`pnpm test:e2e`, with `REAM_BIN` naming the binary) in a CI job that
 * builds one. A missing piece fails the run with its name — never a skip,
 * which is how this suite once went green on every CI run without running.
 */

import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));
const pluginRoot = path.resolve(here, "../..");
const workspace = path.resolve(pluginRoot, "../..");
const reamBin =
	process.env.REAM_BIN ??
	path.join(workspace, "packages/ream-cli/target/debug/ream");
// The real path: the plugin reaches helix through it, and one module instance
// is what lets the tests register where the runner looks.
const helixIndex = path.join(
	pluginRoot,
	"node_modules/@c9up/helix/src/index.ts",
);
const helixEntry = existsSync(helixIndex)
	? pathToFileURL(realpathSync(helixIndex)).href
	: "";

/**
 * The TS loader `ream test` requires: this package's own devDependency, or
 * the workspace store's in a monorepo checkout installed before it was one.
 */
function swcRegister(): string | undefined {
	const own = path.join(pluginRoot, "node_modules/@swc-node/register");
	if (existsSync(own)) return realpathSync(own);
	const store = path.join(workspace, "node_modules/.pnpm");
	if (!existsSync(store)) return undefined;
	const entry = readdirSync(store).find((name) =>
		name.startsWith("@swc-node+register@"),
	);
	return entry === undefined
		? undefined
		: path.join(store, entry, "node_modules/@swc-node/register");
}

/** The ream this package was installed with: a workspace link or a store copy. */
const reamLink = path.join(pluginRoot, "node_modules/@c9up/ream");
const reamRoot = existsSync(reamLink) ? realpathSync(reamLink) : undefined;

/** ream's own `reflect-metadata`, resolved the way ream resolves it. */
function reflectMetadataRoot(): string | undefined {
	if (reamRoot === undefined) return undefined;
	try {
		return path.dirname(
			createRequire(path.join(reamRoot, "package.json")).resolve(
				"reflect-metadata",
			),
		);
	} catch {
		return undefined;
	}
}

const loader = swcRegister();
const reflectMetadata = reflectMetadataRoot();
const reamTsconfig =
	reamRoot === undefined ? undefined : path.join(reamRoot, "tsconfig.app.json");

/** What this suite cannot run without, named, or nothing when all is there. */
function missing(): string[] {
	const absent: string[] = [];
	if (!existsSync(reamBin))
		absent.push(`the ream binary (${reamBin}; set REAM_BIN)`);
	if (helixEntry === "") absent.push(`@c9up/helix (${helixIndex})`);
	if (loader === undefined) absent.push("@swc-node/register");
	if (reflectMetadata === undefined)
		absent.push("reflect-metadata, from @c9up/ream");
	if (reamTsconfig === undefined || !existsSync(reamTsconfig)) {
		absent.push("@c9up/ream's tsconfig.app.json");
	}
	return absent;
}

let app: string;
const running: ChildProcess[] = [];

function file(relative: string, body: string): void {
	const target = path.join(app, relative);
	mkdirSync(path.dirname(target), { recursive: true });
	writeFileSync(target, body);
}

function link(name: string, target: string): void {
	const at = path.join(app, "node_modules", name);
	mkdirSync(path.dirname(at), { recursive: true });
	symlinkSync(target, at, "dir");
}

const header = `import { expect, test } from ${JSON.stringify(helixEntry)};\n`;

beforeAll(() => {
	const absent = missing();
	if (
		absent.length > 0 ||
		loader === undefined ||
		reflectMetadata === undefined ||
		reamTsconfig === undefined
	) {
		throw new Error(
			`ream test end to end cannot run without: ${absent.join(", ")}`,
		);
	}
	app = mkdtempSync(path.join(tmpdir(), "ream-test-flags-"));
	file("package.json", '{ "name": "flags-fixture", "type": "module" }\n');
	// The loader resolves `.js` specifiers to `.ts` sources through it.
	file("tsconfig.json", JSON.stringify({ extends: reamTsconfig }));
	link("@swc-node/register", loader);
	link("reflect-metadata", reflectMetadata);
	link("@c9up/helix-plugin-ream", pluginRoot);
	file(
		"reamrc.ts",
		// `retries: 0` declared, so `--retries` has a configured value to beat.
		'export default { tests: { suites: [{ name: "unit", files: ["tests/unit/**/*.test.ts"], retries: 0 }] } }\n',
	);
	file(
		"tests/unit/a.test.ts",
		`${header}test("alpha", () => { expect(1).toBe(1) }).tags(["@fast"]);
test("beta, with a comma", () => { expect(1).toBe(1) });
`,
	);
	file(
		"tests/unit/b.test.ts",
		`${header}test.group("grp", () => { test("gamma", () => { expect(1).toBe(1) }) });
test("delta", () => { expect(1).toBe(1) });
`,
	);
	file(
		"tests/unit/slow.test.ts",
		`${header}test("sleeps 400ms", () => new Promise((r) => setTimeout(r, 400)));
`,
	);
	file(
		"tests/unit/flaky.test.ts",
		`${header}let attempts = 0;
test("passes on its second attempt", () => { attempts += 1; expect(attempts).toBe(2) });
`,
	);
	file(
		"tests/unit/marked.test.ts",
		`${header}import { existsSync } from "node:fs";
test("fails while the marker exists", () => { expect(existsSync("fail.marker")).toBe(false) });
`,
	);
});

afterEach(() => {
	for (const child of running.splice(0)) {
		// The whole group: `ream` runs node, which runs the workers.
		if (child.pid !== undefined) {
			try {
				process.kill(-child.pid, "SIGKILL");
			} catch {
				// already gone
			}
		}
	}
});

afterAll(() => {
	if (app !== undefined) rmSync(app, { recursive: true, force: true });
});

function cleanEnv(): Record<string, string | undefined> {
	const env: Record<string, string | undefined> = { ...process.env };
	for (const key of Object.keys(env)) {
		if (key.startsWith("HELIX_") || key === "CI" || key === "NODE_ENV") {
			delete env[key];
		}
	}
	return env;
}

function ream(...args: string[]) {
	const result = spawnSync(reamBin, ["test", ...args], {
		cwd: app,
		env: cleanEnv(),
		encoding: "utf8",
		timeout: 90_000,
	});
	return {
		status: result.status,
		output: `${result.stdout}\n${result.stderr}`,
	};
}

/** The tests a spec run reports as passed / failed. */
function ran(output: string): string[] {
	return output
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.startsWith("✔") || line.startsWith("✘"))
		.filter((line) => !line.includes(".test.ts"))
		.map((line) => line.slice(2));
}

describe("ream test — filters and tuning flags", () => {
	it("--files narrows the run to the matching files", () => {
		const run = ream("--files", "tests/unit/a.test.ts");
		expect(run.status).toBe(0);
		expect(ran(run.output).sort()).toEqual(["alpha", "beta, with a comma"]);
	}, 120_000);

	it("--tags keeps the tagged tests only", () => {
		const run = ream("--files", "a", "--tags", "@fast");
		expect(ran(run.output)).toEqual(["alpha"]);
	}, 120_000);

	it("--tests matches a title with a comma, whole", () => {
		const run = ream("--tests", "beta, with a comma");
		expect(run.status).toBe(0);
		expect(ran(run.output)).toEqual(["beta, with a comma"]);
	}, 120_000);

	it("--groups keeps the tests of that group", () => {
		const run = ream("--groups", "grp");
		expect(run.status).toBe(0);
		expect(ran(run.output)).toEqual(["grp > gamma"]);
	}, 120_000);

	it("--timeout overrides the configured timeout", () => {
		const run = ream("--files", "slow", "--timeout", "100");
		expect(run.status).toBe(1);
		expect(run.output).toContain("exceeded 100ms timeout");
	}, 120_000);

	it("--retries gives every test extra attempts, over the suite's own", () => {
		expect(ream("--files", "flaky").status).toBe(1);
		expect(ream("--files", "flaky", "--retries", "1").status).toBe(0);
	}, 120_000);

	it("--failed re-runs only what failed last time", () => {
		writeFileSync(path.join(app, "fail.marker"), "");
		try {
			expect(ream("--files", "a", "--files", "marked").status).toBe(1);
		} finally {
			rmSync(path.join(app, "fail.marker"));
		}
		const run = ream("--failed");
		expect(run.status).toBe(0);
		expect(ran(run.output)).toEqual(["fails while the marker exists"]);
	}, 120_000);

	for (const poll of [false, true]) {
		it(`--watch re-runs on a change${poll ? " (--poll)" : ""}, clearing the screen unless --no-clear`, async () => {
			for (const noClear of [false, true]) {
				const args = ["test", "--watch", "--files", "delta-only"];
				// A dedicated file, so the change does not disturb the others.
				file(
					"tests/unit/delta-only.test.ts",
					`${header}test("watched", () => { expect(1).toBe(1) });\n`,
				);
				if (poll) args.push("--poll");
				if (noClear) args.push("--no-clear");
				const child = spawn(reamBin, args, {
					cwd: app,
					env: cleanEnv(),
					detached: true,
					stdio: ["ignore", "pipe", "pipe"],
				});
				running.push(child);
				let output = "";
				child.stdout?.on("data", (chunk: Buffer) => {
					output += chunk.toString();
				});
				child.stderr?.on("data", (chunk: Buffer) => {
					output += chunk.toString();
				});
				const until = async (text: string): Promise<boolean> => {
					const deadline = Date.now() + 60_000;
					while (!output.includes(text) && Date.now() < deadline) {
						await new Promise((resolve) => setTimeout(resolve, 100));
					}
					return output.includes(text);
				};
				expect(await until("watching for changes")).toBe(true);
				file(
					"tests/unit/delta-only.test.ts",
					`${header}test("watched again", () => { expect(1).toBe(1) });\n`,
				);
				expect(await until("watched again")).toBe(true);
				expect(output.includes("\x1Bc")).toBe(!noClear);
				if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
				running.splice(running.indexOf(child), 1);
			}
		}, 180_000);
	}
});
