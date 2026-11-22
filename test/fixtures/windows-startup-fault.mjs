import assert from 'node:assert/strict'
import path from 'node:path'
import koffi from 'koffi'

const [directory, mode, fixture] = process.argv.slice(2)
const originalLoad = koffi.load
const handles = new Set()
const closed = []
let processHandle
let pid
let failCleanup = true
let originalTerminate
let originalWait
const pointerBytes = koffi.sizeof('void *')

koffi.load = (...args) => {
  const library = originalLoad(...args)
  const func = library.func.bind(library)
  const wrappedFunc = (...definition) => {
    const original = func(...definition)
    const signature = definition.join(' ')
    if (signature.includes('AssignProcessToJobObject')) return () => 0
    if (signature.includes('TerminateProcess(')) {
      originalTerminate = original
      return (...input) => failCleanup && mode === 'termination' ? 0 : original(...input)
    }
    if (signature.includes('WaitForSingleObject(')) {
      originalWait = original
      const wrapped = (...input) => failCleanup && mode === 'confirmation' && input[1] === 0 ? 258 : original(...input)
      wrapped.async = original.async
      return wrapped
    }
    if (signature.includes('CloseHandle(')) return (handle) => {
      const result = original(handle)
      if (result) closed.push(handle)
      return result
    }
    if (signature.includes('CreateProcessW(')) return (...input) => {
      const result = original(...input)
      if (result) {
        const info = input.at(-1)
        processHandle = koffi.decode(info, 'void *')
        handles.add(processHandle)
        handles.add(koffi.decode(info, pointerBytes, 'void *'))
        pid = info.readUInt32LE(pointerBytes * 2)
      }
      return result
    }
    if (/CreateJobObjectW\(|CreateIoCompletionPort\(|CreateFileW\(/u.test(signature)) return (...input) => {
      const handle = original(...input)
      if (handle !== null && handle !== 0n && handle !== -1n) handles.add(handle)
      return handle
    }
    return original
  }
  return { func: wrappedFunc }
}

const { LanguageServer } = await import('../../dist/server.js')
const { parseOptions } = await import('../../dist/config.js')
const options = parseOptions({ servers: [{ id: 'partial', root: '.', extensions: { '.ts': 'typescript' }, command: [process.execPath, fixture, 'normal', path.join(directory, 'events.jsonl')] }] })
const server = new LanguageServer(options.servers[0], directory, options)
try {
  await assert.rejects(server.start(AbortSignal.timeout(10000)), /cleanup|TerminateProcess|exit has not been confirmed/u)
  assert.ok(pid > 0, 'native suspended process was created before the assignment failure')
  assert.equal(closed.includes(processHandle), false, 'unconfirmed cleanup must retain the process handle for retry')
  assert.ok([...handles].some((handle) => !closed.includes(handle)), 'failed native cleanup keeps its owner reachable')
  failCleanup = false
  await server.stop(false)
  assert.throws(() => process.kill(pid, 0), (error) => error.code === 'ESRCH')
  for (const handle of handles) assert.equal(closed.filter((item) => item === handle).length, 1, 'each acquired native handle closes once after retry')
  console.log(JSON.stringify({ mode, nativeHandles: handles.size, cleanupRetried: true, processGone: true }))
} finally {
  failCleanup = false
  if (processHandle && !closed.includes(processHandle) && originalWait(processHandle, 0) !== 0) originalTerminate(processHandle, 1)
  await server.stop(false)
  koffi.load = originalLoad
}
