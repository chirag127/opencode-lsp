import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import plugin from '../dist/index.js'

export const repository = fileURLToPath(new URL('../', import.meta.url))
export const protocolFixture = fileURLToPath(new URL('./fixtures/server.mjs', import.meta.url))

const resources = new WeakMap()

export function cleanup(t, action) {
  let actions = resources.get(t)
  if (!actions) {
    actions = []
    resources.set(t, actions)
    t.after(async () => {
      const errors = []
      // Node after-hooks are FIFO; dependent resources must be released in reverse acquisition order.
      for (const dispose of actions.reverse()) {
        try { await dispose() } catch (error) { errors.push(error) }
      }
      if (errors.length) throw new AggregateError(errors, 'Synthetic fixture cleanup failed')
    })
  }
  actions.push(action)
}

export async function project(t, files = { 'main.ts': 'export const answer = 42\n' }) {
  const parent = path.join(repository, '.test-tmp')
  await mkdir(parent, { recursive: true })
  const directory = await mkdtemp(path.join(parent, 'lsp-'))
  for (const [file, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(directory, file)), { recursive: true })
    await writeFile(path.join(directory, file), content)
  }
  cleanup(t, () => rm(directory, { recursive: true, force: true }))
  return directory
}

export function configured(directory, mode = 'normal', overrides = {}) {
  return {
    servers: [{
      id: 'fixture', root: '.', extensions: { '.ts': 'typescript' },
      command: [process.execPath, protocolFixture, mode, path.join(directory, 'events.jsonl')],
    }],
    requestTimeoutMs: 5000, shutdownTimeoutMs: 1000, diagnosticsTimeoutMs: 1000,
    ...overrides,
  }
}

export async function harness(t, directory, options = {}, authorize = async () => {}) {
  const tools = new Map()
  const hooks = new Map()
  const permissions = []
  let currentDirectory = directory
  let deliver
  const queued = []
  let disposed = false
  const ctx = {
    options,
    location: { directory },
    session: { get: async ({ sessionID }) => {
      assert.match(sessionID, /^ses_test/u)
      return { location: { directory: currentDirectory } }
    } },
    permission: { assert: async (input) => {
      permissions.push(input)
      await authorize(input)
    } },
    tool: {
      transform: async (transform) => {
        transform({ namespace() {}, add: (tool) => tools.set(`${tool.options.namespace}_${tool.name}`, tool) })
        return { dispose: async () => {} }
      },
      hook: async (name, hook) => { hooks.set(name, hook); return { dispose: async () => {} } },
    },
    event: { async * subscribe({ signal }) {
      while (!signal.aborted) {
        const event = queued.shift() ?? await new Promise((resolve) => {
          const abort = () => { deliver = undefined; resolve(undefined) }
          deliver = (value) => { signal.removeEventListener('abort', abort); deliver = undefined; resolve(value) }
          signal.addEventListener('abort', abort, { once: true })
          if (signal.aborted) abort()
        })
        if (event) yield event
      }
    } },
  }
  const disposePlugin = await plugin.setup(ctx)
  const close = async () => { if (!disposed) { disposed = true; await disposePlugin() } }
  cleanup(t, close)
  const caller = (extra = {}) => ({
    sessionID: 'ses_test', agent: 'build', messageID: 'msg_test', id: 'call_test',
    signal: new AbortController().signal, progress: async () => {}, ...extra,
  })
  return {
    tools, hooks, permissions, caller, close,
    move: (value) => { currentDirectory = value },
    event: (event) => { if (deliver) deliver(event); else queued.push(event) },
    async call(name, input = {}, context = caller()) {
      const tool = tools.get(`lsp_${name}`)
      assert.ok(tool, `tool lsp_${name} is registered`)
      const result = await tool.execute(input, context)
      try { return JSON.parse(result.content) } catch { return result.content }
    },
    async edited(tool = 'patch', context = caller()) {
      const event = { ...context, tool, status: 'completed', input: {}, result: { content: 'Saved synthetic file.', metadata: { existing: true } } }
      await hooks.get('execute.after')(event)
      return event.result
    },
  }
}

export function gone(pid) {
  try { process.kill(pid, 0); return false } catch (error) {
    if (error.code === 'ESRCH') return true
    throw error
  }
}

export async function events(directory) {
  try { return (await readFile(path.join(directory, 'events.jsonl'), 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse) }
  catch (error) { if (error.code === 'ENOENT') return []; throw error }
}
