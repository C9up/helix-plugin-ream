/**
 * `ctx.client` is a fresh client per test, over the one server the file
 * booted. Request state a test sets — a default header, an `authorization` it
 * logs in with — must not reach the next test, or results depend on order: an
 * "anonymous gets 401" test passes or fails depending on what ran before it.
 *
 * Driven through the real `helix test` CLI, so the plugin, the helix context
 * and the per-test getter are the ones a project gets.
 */

import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { helixEntryPath } from "../helpers/helix-entry.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const helixBin = path.resolve(
	here,
	"../../node_modules/@c9up/helix/bin/helix.js",
);
const pluginUrl = pathToFileURL(path.resolve(here, "../../src/index.ts")).href;
const helixEntry = helixEntryPath(path.resolve(here, "../.."));
if (helixEntry === undefined) {
	throw new Error("@c9up/helix is not installed with a root entry");
}
const helixUrl = pathToFileURL(helixEntry).href;
const utilsUrl = pathToFileURL(
	path.resolve(here, "../../node_modules/@c9up/ream/src/testing/testUtils.ts"),
).href;

const roots: string[] = [];

afterAll(async () => {
	await Promise.all(
		roots.map((root) => rm(root, { recursive: true, force: true })),
	);
});

/** A server echoing the `authorization` it received, counting its boots. */
const bootSource = (log: string) =>
	[
		'import http from "node:http";',
		'import { appendFileSync } from "node:fs";',
		"export const boot = (port: number) =>",
		"	new Promise<{ port: number; close: () => Promise<void> }>((resolve) => {",
		`		appendFileSync(${JSON.stringify(log)}, "boot\\n");`,
		"		const server = http.createServer((req, res) => {",
		'			res.writeHead(200, { "content-type": "application/json" });',
		"			res.end(JSON.stringify({ authorization: req.headers.authorization ?? null }));",
		"		});",
		"		server.listen(port, () => {",
		"			const a = server.address();",
		"			resolve({",
		'				port: typeof a === "object" && a ? a.port : port,',
		"				close: () => new Promise<void>((r) => server.close(() => r())),",
		"			});",
		"		});",
		"	});",
		"",
	].join("\n");

const testSource = [
	`import { expect, test } from "${helixUrl}";`,
	`import { testClient } from "${pluginUrl}";`,
	'test("test 1 logs in as admin", async ({ client }) => {',
	'	client.withHeader("authorization", "Bearer ADMIN-TOKEN");',
	'	const res = await client.get("/");',
	'	expect(res.body()).toEqual({ authorization: "Bearer ADMIN-TOKEN" });',
	"});",
	'test("test 2 is anonymous", async ({ client }) => {',
	'	const res = await client.get("/");',
	"	expect(res.body()).toEqual({ authorization: null });",
	"});",
	'test("testClient() is this test\'s client", async ({ client }) => {',
	"	expect(testClient()).toBe(client);",
	'	client.withHeader("authorization", "Bearer MINE");',
	'	const res = await testClient().get("/");',
	'	expect(res.body()).toEqual({ authorization: "Bearer MINE" });',
	"});",
	"",
].join("\n");

async function project(bootstrap: string): Promise<string> {
	const root = await mkdtemp(path.join(os.tmpdir(), "helix-plugin-ream-"));
	roots.push(root);
	await mkdir(path.join(root, "tests"), { recursive: true });
	await writeFile(path.join(root, "package.json"), '{ "type": "module" }\n');
	await writeFile(
		path.join(root, "tests/boot.ts"),
		bootSource(path.join(root, "boots.log")),
	);
	await writeFile(path.join(root, "tests/bootstrap.ts"), bootstrap);
	await writeFile(path.join(root, "tests/leak.test.ts"), testSource);
	return root;
}

function runHelix(root: string) {
	const env: Record<string, string | undefined> = { ...process.env };
	for (const key of Object.keys(env)) {
		if (key.startsWith("HELIX_") || key === "CI") delete env[key];
	}
	return spawnSync(
		process.execPath,
		[helixBin, "test", "tests/leak.test.ts", "--colors=false"],
		{ cwd: root, env, encoding: "utf8", timeout: 60_000 },
	);
}

async function boots(root: string): Promise<number> {
	const log = await readFile(path.join(root, "boots.log"), "utf8");
	return log.trim().split("\n").length;
}

describe("apiClient — one client per test", () => {
	it("keeps a header one test set out of the next ({ boot })", async () => {
		const root = await project(
			[
				`import { apiClient } from "${pluginUrl}";`,
				'import { boot } from "./boot.ts";',
				"export const plugins = [apiClient({ boot })];",
				"",
			].join("\n"),
		);
		const run = runHelix(root);
		expect(run.stdout).toContain("3 passed");
		expect(run.status).toBe(0);
		// Still one server for the whole file.
		expect(await boots(root)).toBe(1);
	});

	it("keeps a header one test set out of the next ({ testUtils })", async () => {
		const root = await project(
			[
				`import { apiClient } from "${pluginUrl}";`,
				`import { createTestUtils } from "${utilsUrl}";`,
				'import { boot } from "./boot.ts";',
				"const testUtils = createTestUtils(boot);",
				"export const plugins = [apiClient({ testUtils })];",
				"export const configureSuite = (suite) =>",
				"	suite.setup(() => testUtils.httpServer().start());",
				"",
			].join("\n"),
		);
		const run = runHelix(root);
		expect(run.stdout).toContain("3 passed");
		expect(run.status).toBe(0);
		expect(await boots(root)).toBe(1);
	});
});
