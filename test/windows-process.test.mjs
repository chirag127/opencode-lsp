import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { pathToFileURL } from 'node:url'
import path from 'node:path'
import { test } from 'node:test'
import { project, protocolFixture, repository } from './helpers.mjs'

const run = promisify(execFile)

test('a live Windows server leaves a two-thread libuv pool available for filesystem work', { skip: process.platform !== 'win32', timeout: 20000 }, async (t) => {
  const directory = await project(t)
  const script = `
    import assert from 'node:assert/strict';
    import { stat } from 'node:fs/promises';
    import { LanguageServer } from ${JSON.stringify(pathToFileURL(path.join(repository, 'dist/server.js')).href)};
    import { parseOptions } from ${JSON.stringify(pathToFileURL(path.join(repository, 'dist/config.js')).href)};
    const options = parseOptions({ servers: [{ id: 'pool', root: '.', extensions: { '.ts': 'typescript' }, command: ${JSON.stringify([process.execPath, protocolFixture, 'normal', path.join(directory, 'events.jsonl')])} }] });
    const server = new LanguageServer(options.servers[0], ${JSON.stringify(directory)}, options);
    let timer;
    try {
      await server.start(AbortSignal.timeout(5000));
      const result = await Promise.race([
        stat(${JSON.stringify(path.join(directory, 'main.ts'))}),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Filesystem work starved behind native process waits')), 1000); })
      ]);
      assert.ok(result.isFile());
      console.log('filesystem-progress-with-live-server');
    } finally { clearTimeout(timer); await server.stop(false); }
  `
  const result = await run(process.execPath, ['--input-type=module', '-e', script], {
    cwd: repository, timeout: 15000, env: { ...process.env, UV_THREADPOOL_SIZE: '2' },
  })
  assert.match(result.stdout, /filesystem-progress-with-live-server/u)
})

for (const mode of ['termination', 'confirmation']) {
  test(`failed Windows startup retains native ownership when ${mode} fails, then releases on retry`, { skip: process.platform !== 'win32', timeout: 20000 }, async (t) => {
    const directory = await project(t)
    const result = await run(process.execPath, [path.join(repository, 'test/fixtures/windows-startup-fault.mjs'), directory, mode, protocolFixture], {
      cwd: repository, timeout: 15000, env: { ...process.env, UV_THREADPOOL_SIZE: '2' },
    })
    const outcome = JSON.parse(result.stdout)
    assert.equal(outcome.mode, mode)
    assert.equal(outcome.cleanupRetried, true)
    assert.equal(outcome.processGone, true)
    assert.equal(outcome.nativeHandles, 7)
  })
}
