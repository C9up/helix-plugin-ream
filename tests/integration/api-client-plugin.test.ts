/**
 * The `apiClient()` helix plugin: calling it registers a TestClient on the
 * context as `client`, which starts its server on the first request rather
 * than at plugin time. Exercised against a trivial Node server via a mock
 * PluginApi (no helix runtime needed).
 */

import http from "node:http";
import { TestClient } from "@c9up/ream/testing";
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

describe("helix plugin > apiClient()", () => {
	it("registers a client on the context and serves requests", async () => {
		const { boot } = makeServer();

		// Mock PluginApi — capture what the plugin registers under `client`.
		let registered: TestClient | undefined;
		const teardowns: Array<() => void | Promise<void>> = [];
		const api = {
			context: {
				macro(name: string, value: unknown) {
					if (name === "client" && value instanceof TestClient)
						registered = value;
				},
				getter() {},
			},
			cleanup(fn: () => void | Promise<void>) {
				teardowns.push(fn);
			},
		};

		await apiClient({ boot })(api);

		if (!registered) throw new Error("apiClient did not register a `client`");

		// Unified builder: the verb shortcut carries the helix assertion surface AND
		// is awaitable — `await client.get('/x').assertOk()` (the documented form).
		await registered.get("/health").assertOk().assertBody({ ok: true });
		await registered.get("/missing").assertNotFound();

		// A plain await (no assertion) still resolves to the rich response.
		const res = await registered.get("/health");
		expect(res.status()).toBe(200);
		expect(res.json()).toEqual({ ok: true });
		// helix accessor surface on the awaited response.
		expect(res.header("content-type")).toContain("application/json");
		expect(res.assertOk().text()).toBe('{"ok":true}');

		// F8: `client.request(url, method)` — helix arg order (URL first, method
		// second, defaulting to GET). Returns the same rich awaitable builder.
		await registered.request("/health").assertOk();
		await registered.request("/health", "GET").assertBody({ ok: true });
		await registered.request("/missing", "GET").assertNotFound();

		// The plugin registered a teardown to close the server (no manual close).
		expect(teardowns).toHaveLength(1);
		for (const fn of teardowns) await fn();
	});
});

describe("helix plugin > lazy boot", () => {
	it("starts no server when the plugin runs", async () => {
		let boots = 0;
		const boot = async () => {
			boots += 1;
			return { port: 4321, close: () => {} };
		};
		let registered: TestClient | undefined;
		const api = {
			context: {
				macro(name: string, value: unknown) {
					if (name === "client" && value instanceof TestClient)
						registered = value;
				},
				getter() {},
			},
			cleanup() {},
		};

		await apiClient({ boot })(api);

		// This is the whole point: a file that issues no request pays nothing.
		// Eager booting cost ~400ms per file, on every file, most of which are
		// unit tests with no HTTP in them.
		expect(boots).toBe(0);
		expect(registered?.booted).toBe(false);
	});

	it("closes cleanly when nothing was ever started", async () => {
		const boot = async () => ({ port: 1, close: () => {} });
		const teardowns: Array<() => void | Promise<void>> = [];
		const api = {
			context: { macro() {}, getter() {} },
			cleanup(fn: () => void | Promise<void>) {
				teardowns.push(fn);
			},
		};

		await apiClient({ boot })(api);
		// Unconditional teardown against a client that never booted.
		await expect(teardowns[0]?.()).resolves.toBeUndefined();
	});
});

describe("helix plugin > testClient()", () => {
	it("hands back the same instance the context carries", async () => {
		const { boot } = makeServer();
		let registered: TestClient | undefined;
		const teardowns: Array<() => void | Promise<void>> = [];
		const api = {
			context: {
				macro(name: string, value: unknown) {
					if (name === "client" && value instanceof TestClient)
						registered = value;
				},
				getter() {},
			},
			cleanup(fn: () => void | Promise<void>) {
				teardowns.push(fn);
			},
		};

		await apiClient({ boot })(api);

		// Same object, not a second client — booting one boots the other, which
		// is what makes it usable from a fixture or a runner hook.
		expect(testClient()).toBe(registered);
		await testClient().get("/health").assertOk();
		expect(registered?.booted).toBe(true);

		await teardowns[0]?.();
		// The teardown forgets it, so a later read reports the wiring gap rather
		// than handing back a closed client.
		expect(() => testClient()).toThrowError(/E_NO_TEST_CLIENT/);
	});
});
