/**
 * The `apiClient()` helix plugin, in the AdonisJS shape: the plugin puts a
 * CLIENT on the test context and the SERVER is started by a suite hook
 * (`testUtils.httpServer().start()`), so a suite that does not declare the hook
 * never starts one. Exercised against a trivial Node server via a mock
 * PluginApi (no helix runtime needed).
 */

import http from "node:http";
import type { TestClient } from "@c9up/ream/testing";
import { createTestUtils } from "@c9up/ream/testing/utils";
import { describe, expect, it } from "vitest";
import { apiClient, testClient } from "../../src/index.js";

function makeServer() {
	const server = http.createServer((req, res) => {
		if (req.url === "/health") {
			res.writeHead(200, { "content-type": "application/json" });
			res.end('{"ok":true}');
		} else {
			res.writeHead(404);
			res.end("nope");
		}
	});
	const boot = (port: number) =>
		new Promise<{ port: number; close: () => Promise<void> }>((resolve) => {
			server.listen(port, () => {
				const addr = server.address();
				const actualPort = typeof addr === "object" && addr ? addr.port : port;
				resolve({
					port: actualPort,
					close: () => new Promise<void>((r) => server.close(() => r())),
				});
			});
		});
	return { boot };
}

/** A mock `PluginApi` that captures what the plugin registers. */
function makeApi() {
	let read: (() => unknown) | undefined;
	const teardowns: Array<() => void | Promise<void>> = [];
	const api = {
		context: {
			macro() {},
			// Signature matches helix's: the callback receives the context. This
			// plugin's getter ignores it, so the mock can call it with nothing.
			getter(name: string, fn: (ctx: never) => unknown) {
				if (name === "client") read = () => fn(undefined as never);
			},
		},
		cleanup(fn: () => void | Promise<void>) {
			teardowns.push(fn);
		},
	};
	return {
		api,
		teardowns,
		/** What a test body would get from `ctx.client`. */
		client: (): TestClient => {
			if (!read) throw new Error("no `client` getter was registered");
			return read() as TestClient;
		},
	};
}

describe("helix plugin > apiClient({ testUtils }) — the AdonisJS shape", () => {
	it("starts nothing itself; the suite hook owns the server", async () => {
		const { boot } = makeServer();
		const testUtils = createTestUtils(boot);
		const { api, client, teardowns } = makeApi();

		await apiClient({ testUtils })(api);

		// The plugin has run and no server exists — that is the point of the
		// shape: a unit suite declares no hook and pays nothing.
		expect(testUtils.client()).toBeUndefined();
		expect(() => client()).toThrowError(/E_SERVER_NOT_STARTED/);

		// The suite's setup hook starts it, and hands back its own teardown.
		const stop = await testUtils.httpServer().start();

		await client().get("/health").assertOk().assertBody({ ok: true });
		await client().get("/missing").assertNotFound();

		// A plain await (no assertion) still resolves to the rich response.
		const res = await client().get("/health");
		expect(res.status()).toBe(200);
		expect(res.json()).toEqual({ ok: true });
		expect(res.header("content-type")).toContain("application/json");

		// `client.request(url, method)` — URL first, method second, GET default.
		await client().request("/health").assertOk();
		await client().request("/missing", "GET").assertNotFound();

		// The plugin registered a teardown, but the SERVER belongs to the hook.
		expect(teardowns).toHaveLength(1);
		await teardowns[0]?.();
		await stop();
	});

	it("names the missing hook rather than failing on a dead connection", async () => {
		const { boot } = makeServer();
		const { api, client } = makeApi();
		await apiClient({ testUtils: createTestUtils(boot) })(api);

		// The message has to say what to add: "connection refused" from a request
		// is the least useful way to learn a hook is missing.
		expect(() => client()).toThrowError(
			/suite\.setup\(\(\) => testUtils\.httpServer\(\)/,
		);
	});
});

describe("helix plugin > apiClient({ boot }) — for suites that are not split", () => {
	it("starts no server until a request is made", async () => {
		let boots = 0;
		const boot = async () => {
			boots += 1;
			return { port: 4321, close: () => {} };
		};
		const { api, client } = makeApi();

		await apiClient({ boot })(api);

		// Reading the client is not issuing a request.
		expect(client().booted).toBe(false);
		expect(boots).toBe(0);
	});

	it("serves requests and closes what it started", async () => {
		const { boot } = makeServer();
		const { api, client, teardowns } = makeApi();

		await apiClient({ boot })(api);
		await client().get("/health").assertOk();
		expect(client().booted).toBe(true);

		await teardowns[0]?.();
		// The plugin owns this server, so its teardown is what stops it.
		expect(client().booted).toBe(false);
	});

	it("closes cleanly when nothing was ever started", async () => {
		const boot = async () => ({ port: 1, close: () => {} });
		const { api, teardowns } = makeApi();
		await apiClient({ boot })(api);
		await expect(teardowns[0]?.()).resolves.toBeUndefined();
	});
});

describe("helix plugin > apiClient() with neither", () => {
	it("refuses at plugin time instead of at the first request", async () => {
		const { api } = makeApi();
		await expect(apiClient({})(api)).rejects.toThrowError(/E_NO_SERVER/);
	});
});

describe("helix plugin > testClient()", () => {
	it("hands back the instance the context carries", async () => {
		const { boot } = makeServer();
		const testUtils = createTestUtils(boot);
		const { api, client, teardowns } = makeApi();

		await apiClient({ testUtils })(api);
		const stop = await testUtils.httpServer().start();

		// Same object, not a second client — booting one boots the one the tests
		// use, which is what makes it usable from a fixture or a runner hook.
		expect(testClient()).toBe(client());
		await testClient().get("/health").assertOk();

		await teardowns[0]?.();
		// The teardown forgets it, so a later read reports the wiring gap rather
		// than handing back a client whose server is gone.
		expect(() => testClient()).toThrowError(/E_NO_TEST_CLIENT/);
		await stop();
	});
});
