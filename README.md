# @c9up/helix-plugin-ream

The bridge between [Ream](https://github.com/C9up/ream) and [helix](https://github.com/C9up/helix), its test runner.

Ream knows nothing about helix, helix knows nothing about Ream. The plugin that joins them lives here and declares both sides as peers.

## Install

```sh
pnpm add -D @c9up/helix-plugin-ream @c9up/helix
```

## Inject a test client

`tests/bootstrap.ts` exports `plugins`, `runnerHooks` and `configureSuite`; it never calls `configure()` itself. helix imports it and configures each run with those exports and the name of the suite being run — a `configure()` called in the file would run at import time, before any suite exists. `ream new` writes this file:

```ts
// tests/bootstrap.ts
import type { ConfigureOptions, Plugin, RunnerHook } from '@c9up/helix'
import { apiClient } from '@c9up/helix-plugin-ream'
import { createTestUtils } from '@c9up/ream/testing/utils'

export const testUtils = createTestUtils((port) => bootApp(port))

export const plugins: Plugin[] = [apiClient({ testUtils })]

export const runnerHooks: { setup: RunnerHook[]; teardown: RunnerHook[] } = {
  setup: [],
  teardown: [],
}

export const configureSuite: ConfigureOptions['configureSuite'] = (suite) => {
  if (suite.name === 'functional') {
    return suite.setup(() => testUtils.httpServer().start())
  }
}
```

```ts
test('health', async ({ client }) => {
  await client.get('/health').assertOk()
})
```

With `testUtils`, the suite hook owns the server: the plugin reads the client of the server that hook started, and a suite that declares no hook starts none. For a project whose suites are not split yet, `apiClient({ boot: (port) => bootApp(port) })` lets the client own its server instead: it starts on the client's first request and closes through `api.cleanup` when the run ends.

## Run the suites declared in the rc file

```ts
import { runTestsFromRcFile } from '@c9up/helix-plugin-ream/runner'
```

This is what `ream test` calls.

## What stays in Ream

`TestClient`, `createTestClient`, `RequestBuilder` and `ApiResponse` live in `@c9up/ream/testing`. They drive a Ream server over HTTP and owe nothing to the runner, so they need no plugin.
