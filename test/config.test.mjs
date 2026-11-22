import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseOptions } from '../dist/config.js'

const server = {
  id: 'ts',
  command: ['node', '/installed/language-server.mjs', '--stdio'],
  root: '.',
  extensions: { '.ts': 'typescript' },
}

test('malformed configuration cannot authorize an implicit command or root', () => {
  for (const options of [
    null,
    { servers: 'ts' },
    { servers: [{ ...server, command: 'node server.js' }] },
    { servers: [{ ...server, command: [] }] },
    { servers: [{ ...server, command: [''] }] },
    { servers: [{ ...server, root: undefined }] },
    { servers: [{ ...server, root: '' }] },
    { servers: [{ ...server, extensions: {} }] },
    { servers: [{ ...server, extensions: { ts: 'typescript' } }] },
    { servers: [{ ...server, extensions: { '.ts': '' } }] },
    { servers: [server, server] },
    { servers: [server], requestTimeoutMs: 0 },
    { servers: [server], shell: true },
    { servers: [{ ...server, args: ['--stdio'] }] },
  ]) {
    assert.throws(() => parseOptions(options), /configuration/i, JSON.stringify(options))
  }
})

test('an unconfigured plugin remains inert and valid explicit configuration is copied', () => {
  assert.deepEqual(parseOptions({}).servers, [])
  const options = parseOptions({ servers: [server] })
  server.command.push('--another-argument')
  assert.deepEqual(options.servers[0].command, ['node', '/installed/language-server.mjs', '--stdio'])
  server.command.pop()
})
