/**
 * The `apiClient()` helix plugin (Japa `@japa/api-client` parity): calling the
 * plugin registers a BOOTED TestClient on the context as `client`. Exercised
 * against a trivial Node server via a mock PluginApi (no helix runtime needed).
 */

import http from 'node:http'
import { describe, expect, it } from 'vitest'
import { TestClient } from '@c9up/ream/testing'
import { apiClient } from '../../src/index.js'

function makeServer() {
  const server = http.createServer((req, res) => {
    if (req.url === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{"ok":true}')
    } else {
      res.writeHead(404)
      res.end('nope')
    }
  })
  const boot = (port: number) =>
    new Promise<{ port: number; close: () => Promise<void> }>((resolve) => {
      server.listen(port, () => {
        const addr = server.address()
        const actualPort = typeof addr === 'object' && addr ? addr.port : port
        resolve({
          port: actualPort,
          close: () => new Promise<void>((r) => server.close(() => r())),
        })
      })
    })
  return { boot }
}

describe('helix plugin > apiClient()', () => {
  it('registers a booted client on the context', async () => {
    const { boot } = makeServer()

    // Mock PluginApi — capture what the plugin registers under `client`.
    let registered: TestClient | undefined
    const teardowns: Array<() => void | Promise<void>> = []
    const api = {
      context: {
        macro(name: string, value: unknown) {
          if (name === 'client' && value instanceof TestClient) registered = value
        },
        getter() {},
      },
      cleanup(fn: () => void | Promise<void>) {
        teardowns.push(fn)
      },
    }

    await apiClient({ boot })(api)

    if (!registered) throw new Error('apiClient did not register a `client`')

    // Unified builder: the verb shortcut carries the japa assertion surface AND
    // is awaitable — `await client.get('/x').assertOk()` (the documented form).
    await registered.get('/health').assertOk().assertBody({ ok: true })
    await registered.get('/missing').assertNotFound()

    // A plain await (no assertion) still resolves to the rich response.
    const res = await registered.get('/health')
    expect(res.status()).toBe(200)
    expect(res.json()).toEqual({ ok: true })
    // Japa accessor surface on the awaited response.
    expect(res.header('content-type')).toContain('application/json')
    expect(res.assertOk().text()).toBe('{"ok":true}')

    // F8: `client.request(url, method)` — Japa arg order (URL first, method
    // second, defaulting to GET). Returns the same rich awaitable builder.
    await registered.request('/health').assertOk()
    await registered.request('/health', 'GET').assertBody({ ok: true })
    await registered.request('/missing', 'GET').assertNotFound()

    // The plugin registered a teardown to close the server (no manual close).
    expect(teardowns).toHaveLength(1)
    for (const fn of teardowns) await fn()
  })
})
