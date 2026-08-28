# @c9up/helix-plugin-ream

The bridge between [Ream](https://github.com/C9up/ream) and [helix](https://github.com/C9up/helix), its test runner.

Ream knows nothing about helix, helix knows nothing about Ream. The plugin that joins them lives here and declares both sides as peers — the same shape AdonisJS uses to join its own runner to the framework.

## Install

```sh
pnpm add -D @c9up/helix-plugin-ream @c9up/helix
```

## Inject a test client

```ts
// tests/bootstrap.ts
import { configure } from '@c9up/helix'
import { apiClient } from '@c9up/helix-plugin-ream'

await configure({ plugins: [apiClient({ boot: () => bootApp() })] })
```

```ts
test('health', async ({ client }) => {
  await client.get('/health').assertOk()
})
```

The server boots once at `configure()` time, is shared across the run, and closes through `api.cleanup` when the run ends.

## Run the suites declared in the rc file

```ts
import { runTestsFromRcFile } from '@c9up/helix-plugin-ream/runner'
```

This is what `ream test` calls.

## What stays in Ream

`TestClient`, `createTestClient`, `RequestBuilder` and `ApiResponse` live in `@c9up/ream/testing`. They drive a Ream server over HTTP and owe nothing to the runner, so they need no plugin.
