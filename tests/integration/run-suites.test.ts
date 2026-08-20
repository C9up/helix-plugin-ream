import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { runTests } from '../../src/runTests.js'

/**
 * `runTests` with suites that actually match files — the path `ream test`
 * takes on every real run, and the one the unit tests cannot reach: they use a
 * suite matching nothing, so the step-building and the hand-off to helix never
 * execute there.
 */
const here = dirname(fileURLToPath(import.meta.url))
// The generated specs live in a temp dir, so they cannot resolve `@c9up/helix`
// by name — they need an absolute URL. Resolving the package here gives one
// that holds wherever helix comes from: the workspace sources or the published
// dist. A path relative to this file only ever worked inside the monorepo.
const runtimeEntry = import.meta.resolve('@c9up/helix')

const dirs: string[] = []
let root: string
let savedNodeEnv: string | undefined

beforeEach(() => {
  savedNodeEnv = process.env.NODE_ENV
  root = mkdtempSync(join(tmpdir(), 'ream-suites-'))
  dirs.push(root)
})

afterEach(() => {
  if (savedNodeEnv === undefined) delete process.env.NODE_ENV
  else process.env.NODE_ENV = savedNodeEnv
  delete process.env.HELIX_BOOTSTRAP
  delete process.env.HELIX_FORCE_EXIT
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/**
 * The tsx loader, so the spawned workers read TS. Resolved through the package
 * itself (tsx exports `.` as dist/loader.mjs) rather than by walking up to a
 * pnpm store — the layout differs between this repo and a workspace checkout.
 */
function nodeArgs(): string[] {
  try {
    return ['--import', import.meta.resolve('tsx')]
  } catch {
    return []
  }
}

/** Write a spec file under `root`, creating its directory. */
function spec(relative: string, body: string): void {
  const absolute = join(root, relative)
  mkdirSync(dirname(absolute), { recursive: true })
  writeFileSync(absolute, `import { test } from ${JSON.stringify(runtimeEntry)}\n${body}\n`)
}

describe('runTests — suites that match files', () => {
  it('runs every declared suite and reports success', async () => {
    spec('tests/unit/a.spec.ts', 'test("unit green", () => {})')
    spec('tests/functional/b.spec.ts', 'test("functional green", () => {})')

    const code = await runTests(
      {
        suites: [
          { name: 'unit', files: 'tests/unit/**/*.spec.ts' },
          { name: 'functional', files: 'tests/functional/**/*.spec.ts' },
        ],
      },
      { root, nodeArgs: nodeArgs(), reporters: ['dot'] },
    )

    expect(code).toBe(0)
  }, 60_000)

  it('fails the run when a suite fails', async () => {
    spec('tests/unit/a.spec.ts', 'test("red", () => { throw new Error("boom") })')

    const code = await runTests(
      { suites: [{ name: 'unit', files: 'tests/unit/**/*.spec.ts' }] },
      { root, nodeArgs: nodeArgs(), reporters: ['dot'] },
    )

    expect(code).toBe(1)
  }, 60_000)

  it('gives each suite its own name and does not leak retries into the next', async () => {
    // The suite name reaches the test as meta.suite.name, and a suite that
    // declares no retries must not inherit the previous suite's — the two
    // things step-building is responsible for.
    spec(
      'tests/retried/a.spec.ts',
      `test("sees its own suite and retries", (ctx) => {
         if (ctx.test.options.meta.suite.name !== "retried") throw new Error("suite")
         if (ctx.test.options.retries !== 2) throw new Error("retries=" + ctx.test.options.retries)
       })`,
    )
    spec(
      'tests/plain/b.spec.ts',
      `test("inherits no retries", (ctx) => {
         if (ctx.test.options.meta.suite.name !== "plain") throw new Error("suite")
         if (ctx.test.options.retries !== 0) throw new Error("retries=" + ctx.test.options.retries)
       })`,
    )

    const code = await runTests(
      {
        suites: [
          { name: 'retried', files: 'tests/retried/**/*.spec.ts', retries: 2 },
          { name: 'plain', files: 'tests/plain/**/*.spec.ts' },
        ],
      },
      { root, nodeArgs: nodeArgs(), reporters: ['dot'] },
    )

    expect(code).toBe(0)
  }, 60_000)
})
