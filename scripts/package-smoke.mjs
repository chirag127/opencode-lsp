import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'

const run = promisify(execFile)
const repository = fileURLToPath(new URL('../', import.meta.url))
const npm = process.env.npm_execpath
assert.ok(npm, 'Run through npm run pack:check so the portable npm CLI path is available')
const parent = path.join(repository, '.test-tmp')
await mkdir(parent, { recursive: true })
const directory = await mkdtemp(path.join(parent, 'package-'))
const packed = await run(process.execPath, [npm, 'pack', '--json', '--pack-destination', directory], { cwd: repository, timeout: 120000 })
const receipts = JSON.parse(packed.stdout)
// npm 12 keys pack receipts by package name; earlier npm releases return an array.
const receipt = (Array.isArray(receipts) ? receipts : Object.values(receipts)).find((item) => item.name === 'opencode-lsp')
assert.ok(receipt, 'npm pack returned the opencode-lsp receipt')
const contents = receipt.files.map((file) => file.path)
assert.ok(contents.includes('dist/index.js'))
assert.ok(contents.includes('dist/index.d.ts'))
assert.ok(contents.includes('LICENSE'))
assert.equal(contents.some((file) => /^(src|test|node_modules)\//u.test(file)), false)
const tarball = path.join(directory, receipt.filename)
await writeFile(path.join(directory, 'package.json'), JSON.stringify({ private: true, type: 'module' }))
await run(process.execPath, [npm, 'install', '--ignore-scripts', '--no-audit', '--no-fund', '--omit=dev', tarball], { cwd: directory, timeout: 240000, maxBuffer: 2 * 1024 * 1024 })
const installed = JSON.parse(await readFile(path.join(directory, 'node_modules/opencode-lsp/package.json'), 'utf8'))
assert.equal(installed.dependencies['@opencode/plugin'], '2.3.2')
const installedSDK = JSON.parse(await readFile(path.join(directory, 'node_modules/@opencode/plugin/package.json'), 'utf8')).version
assert.equal(installedSDK, '2.3.2')
const probe = `
  import assert from 'node:assert/strict';
  import { registerHooks, createRequire } from 'node:module';
  import { realpathSync } from 'node:fs';
  import { writeFile } from 'node:fs/promises';
  import path from 'node:path';
  import { fileURLToPath } from 'node:url';
  const root = realpathSync(process.cwd());
  registerHooks({ resolve(specifier, context, nextResolve) {
    const resolved = nextResolve(specifier, context);
    if (resolved.url.startsWith('file:')) {
      const relative = path.relative(root, realpathSync(fileURLToPath(resolved.url)));
      if (path.isAbsolute(relative) || relative === '..' || relative.startsWith('..' + path.sep)) {
        throw new Error('Module resolved outside the isolated consumer: ' + specifier);
      }
    }
    return resolved;
  } });
  await assert.rejects(import('typescript'), /outside the isolated consumer|Cannot find/u);
  assert.throws(() => createRequire(import.meta.url)('typescript'), /outside the isolated consumer|Cannot find/u);
  const { default: plugin } = await import('opencode-lsp');
  assert.equal(plugin.id, 'opencode-lsp');
  const names = [];
  const tools = new Map();
  const registration = { dispose: async () => {} };
  await writeFile(path.join(root, 'main.ts'), 'export const answer: string = 42\\n');
  await writeFile(path.join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { strict: true, noEmit: true, types: [] }, files: ['main.ts'] }));
  const cleanup = await plugin.setup({
    options: { servers: [{ id: 'typescript', root: '.', extensions: { '.ts': 'typescript' },
      command: ${JSON.stringify([process.execPath, path.join(repository, 'node_modules/typescript-language-server/lib/cli.mjs'), '--stdio'])},
      initializationOptions: { tsserver: { path: ${JSON.stringify(path.join(repository, 'node_modules/typescript/lib/tsserver.js'))} }, disableAutomaticTypingAcquisition: true }
    }], requestTimeoutMs: 20000, diagnosticsTimeoutMs: 20000, shutdownTimeoutMs: 2000 },
    location: { directory: root },
    session: { get: async () => ({ location: { directory: root } }) },
    permission: { assert: async () => {} },
    tool: { transform: async (fn) => { fn({ namespace() {}, add(tool) { names.push(tool.options.namespace + '_' + tool.name); tools.set(tool.name, tool); } }); return registration; }, hook: async () => registration },
    event: { async * subscribe() {} }
  });
  let serverPID;
  let diagnostic;
  const caller = { sessionID: 'ses_package', agent: 'build', messageID: 'msg_package', id: 'call_package', signal: AbortSignal.timeout(30000) };
  try {
    assert.equal(names.length, 8);
    const initial = JSON.parse((await tools.get('status').execute({}, caller)).content);
    assert.equal(initial[0].state, 'idle');
    diagnostic = JSON.parse((await tools.get('diagnostics').execute({ file: 'main.ts' }, caller)).content);
    assert.ok(diagnostic.diagnostics.items.some((item) => item.code === 2322), JSON.stringify(diagnostic));
    serverPID = JSON.parse((await tools.get('status').execute({}, caller)).content)[0].pid;
    assert.ok(serverPID > 0);
  } finally { await cleanup(); }
  assert.throws(() => process.kill(serverPID, 0), (error) => error.code === 'ESRCH');
  console.log(JSON.stringify({ imported: plugin.id, tools: names.sort(), cleanup: 'completed', dependencyIsolation: 'ESM and CommonJS resolution confined to consumer', realDiagnostic: 2322, serverProcessGone: true }));
`
await writeFile(path.join(directory, 'probe.mjs'), probe)
const imported = await run(process.execPath, ['probe.mjs'], { cwd: directory, timeout: 60000, env: { ...process.env, NODE_PATH: '', NODE_OPTIONS: '' } })
const entrypoint = path.join(directory, 'node_modules/opencode-lsp/dist/index.js')
const result = {
  checkedAt: new Date().toISOString(), consumer: directory, tarball,
  sha256: createHash('sha256').update(await readFile(tarball)).digest('hex'),
  integrity: receipt.integrity, installedSDK, entrypoint,
  entrypointSha256: createHash('sha256').update(await readFile(entrypoint)).digest('hex'),
  fileCount: contents.length, probe: JSON.parse(imported.stdout),
}
await writeFile(path.join(directory, 'result.json'), JSON.stringify(result, null, 2) + '\n')
console.log(JSON.stringify(result, null, 2))
