import { randomUUID } from 'node:crypto'
import { stat } from 'node:fs/promises'
import { createServer, type Socket } from 'node:net'
import path from 'node:path'
import { Worker } from 'node:worker_threads'
import koffi from 'koffi'
import { bounded, checkAbort, LspError, message, ProcessStartupError } from './errors.js'
import type { ServerProcess } from './process.js'

const kernel = koffi.load('kernel32.dll')
const api = {
  error: kernel.func('uint32 __stdcall GetLastError()'),
  close: kernel.func('int __stdcall CloseHandle(void *handle)'),
  open: kernel.func('void * __stdcall CreateFileW(str16 name, uint32 access, uint32 share, void *security, uint32 disposition, uint32 flags, void *templateFile)'),
  inherit: kernel.func('int __stdcall SetHandleInformation(void *handle, uint32 mask, uint32 flags)'),
  create: kernel.func('int __stdcall CreateProcessW(str16 application, void *commandLine, void *processSecurity, void *threadSecurity, int inherit, uint32 flags, void *environment, str16 cwd, void *startup, void *info)'),
  resume: kernel.func('uint32 __stdcall ResumeThread(void *thread)'),
  terminate: kernel.func('int __stdcall TerminateProcess(void *process, uint32 code)'),
  wait: kernel.func('uint32 __stdcall WaitForSingleObject(void *handle, uint32 milliseconds)'),
  createJob: kernel.func('void * __stdcall CreateJobObjectW(void *security, str16 name)'),
  setJob: kernel.func('int __stdcall SetInformationJobObject(void *job, int informationClass, void *info, uint32 size)'),
  queryJob: kernel.func('int __stdcall QueryInformationJobObject(void *job, int informationClass, void *info, uint32 size, void *returnedSize)'),
  assign: kernel.func('int __stdcall AssignProcessToJobObject(void *job, void *process)'),
  terminateJob: kernel.func('int __stdcall TerminateJobObject(void *job, uint32 code)'),
  createPort: kernel.func('void * __stdcall CreateIoCompletionPort(void *file, void *existing, uintptr key, uint32 threads)'),
  postCompletion: kernel.func('int __stdcall PostQueuedCompletionStatus(void *port, uint32 bytes, uintptr key, void *overlapped)'),
  initAttributes: kernel.func('int __stdcall InitializeProcThreadAttributeList(void *list, uint32 count, uint32 flags, void *size)'),
  updateAttributes: kernel.func('int __stdcall UpdateProcThreadAttribute(void *list, uint32 flags, uintptr attribute, void *value, uintptr size, void *previous, void *returnedSize)'),
  deleteAttributes: kernel.func('void __stdcall DeleteProcThreadAttributeList(void *list)'),
}

const pointerBytes = koffi.sizeof('void *')
const invalidHandle = pointerBytes === 8 ? 0xffffffffffffffffn : 0xffffffffn
const startup = koffi.struct({
  cb: 'uint32', reserved: 'void *', desktop: 'void *', title: 'void *',
  x: 'uint32', y: 'uint32', width: 'uint32', height: 'uint32', columns: 'uint32', rows: 'uint32', fill: 'uint32',
  flags: 'uint32', show: 'uint16', reservedBytes: 'uint16', reservedData: 'void *',
  stdin: 'void *', stdout: 'void *', stderr: 'void *',
})
const startupEx = koffi.struct({ startup, attributes: 'void *' })
const processInfo = koffi.struct({ process: 'void *', thread: 'void *', pid: 'uint32', tid: 'uint32' })
const basicLimits = koffi.struct({
  processTime: 'int64', jobTime: 'int64', flags: 'uint32', minimum: 'uintptr', maximum: 'uintptr',
  activeLimit: 'uint32', affinity: 'uintptr', priority: 'uint32', scheduling: 'uint32',
})
const extendedLimits = koffi.struct({ basic: basicLimits, io: koffi.array('uint64', 6), processMemory: 'uintptr', jobMemory: 'uintptr', peakProcessMemory: 'uintptr', peakJobMemory: 'uintptr' })
const completionInfo = koffi.struct({ key: 'void *', port: 'void *' })
const accountingInfo = koffi.struct({
  userTime: 'int64', kernelTime: 'int64', periodUserTime: 'int64', periodKernelTime: 'int64',
  pageFaults: 'uint32', totalProcesses: 'uint32', activeProcesses: 'uint32', terminatedProcesses: 'uint32',
})

function failed(name: string, code = api.error() as number): never {
  throw new LspError('WINDOWS_PROCESS', `${name} failed (Win32 ${code})`)
}

function valid(handle: bigint | null): handle is bigint {
  return handle !== null && handle !== 0n && handle !== invalidHandle && handle !== -1n
}

async function executablePath(executable: string, cwd: string): Promise<string> {
  if (/\.(cmd|bat)$/iu.test(executable)) throw new LspError('COMMAND', 'Use an executable argv, for example node plus the server CLI .js/.mjs path, rather than a .cmd/.bat shim')
  const names = path.extname(executable) ? [executable] : [executable + '.exe', executable]
  const directories = /[\\/]/u.test(executable) ? [cwd] : (process.env.PATH ?? '').split(path.delimiter).filter(Boolean).map((item) => item.replace(/^"|"$/gu, ''))
  for (const directory of directories) for (const name of names) {
    const file = path.resolve(cwd, directory, name)
    try { if ((await stat(file)).isFile()) return file } catch (error) {
      if (!['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error
    }
  }
  throw new LspError('SPAWN', `Configured executable was not found: ${executable}`)
}

function quote(argument: string): string {
  if (argument && !/[\s"]/u.test(argument)) return argument
  return '"' + argument.replace(/(\\*)"/gu, '$1$1\\"').replace(/(\\+)$/u, '$1$1') + '"'
}

interface Pipe {
  readonly handle: bigint
  readonly socket: Socket
}

async function pipe(signal: AbortSignal): Promise<Pipe> {
  const name = `\\\\.\\pipe\\opencode-lsp-${randomUUID()}`
  const listener = createServer()
  let handle: bigint | null = null
  let socket: Socket | undefined
  const connected = new Promise<Socket>((resolve, reject) => {
    listener.once('connection', (accepted) => {
      socket = accepted
      // Errors are also delivered to the protocol reader/writer once connected.
      accepted.on('error', () => {})
      resolve(accepted)
    })
    listener.once('error', reject)
  })
  void connected.catch(() => {})
  try {
    await bounded(new Promise<void>((resolve, reject) => {
      listener.once('error', reject)
      listener.listen(name, () => resolve())
    }), 5_000, 'language-server pipe listen', signal)
    handle = api.open(name, 0xc0000000, 0, null, 3, 0, null) as bigint | null
    if (!valid(handle)) failed('CreateFileW(pipe)')
    socket = await bounded(connected, 5_000, 'language-server pipe connection', signal)
    return { handle, socket }
  } catch (error) {
    if (valid(handle)) api.close(handle)
    socket?.destroy()
    throw error
  } finally {
    listener.close()
  }
}

function monitorProcess(processHandle: bigint, port: bigint) {
  const stopMessage = 0xfffffff0
  // The monitor is a file entrypoint; host-only flags such as --input-type must not be inherited.
  const worker = new Worker(new URL('./windows-monitor.js', import.meta.url), { workerData: { processHandle, port, stopMessage }, execArgv: [] })
  let ended = false
  let observedExit = false
  let rejectExit: (error: unknown) => void = () => {}
  const exited = new Promise<{ code: number; signal: null }>((resolve, reject) => {
    rejectExit = reject
    worker.on('message', (event: { type: string; code: number; message: string }) => {
      if (event.type === 'exited') { observedExit = true; resolve({ code: event.code, signal: null }) }
      if (event.type === 'error') reject(new LspError('CLEANUP', event.message))
    })
    worker.once('error', reject)
  })
  void exited.catch(() => {})
  const done = new Promise<void>((resolve) => worker.once('exit', () => {
    ended = true
    if (!observedExit) rejectExit(new LspError('CLEANUP', 'Native process monitor ended before reporting process exit'))
    resolve()
  }))
  return {
    exited, done,
    cancel() { if (!ended && !api.postCompletion(port, stopMessage, 0, null)) failed('PostQueuedCompletionStatus') },
  }
}

export async function spawnWindowsServer(command: readonly [string, ...string[]], cwd: string, signal: AbortSignal): Promise<ServerProcess> {
  const executable = await executablePath(command[0], cwd)
  checkAbort(signal)
  const pipes: Pipe[] = []
  let job: bigint | null = null
  let port: bigint | null = null
  let processHandle: bigint | null = null
  let thread: bigint | null = null
  let monitor: ReturnType<typeof monitorProcess> | undefined
  let assigned = false
  let attributes: bigint | null = null
  let attributesInitialized = false
  const release = () => {
    if (valid(job)) { api.close(job); job = null }
    if (valid(port)) { api.close(port); port = null }
    if (valid(processHandle)) { api.close(processHandle); processHandle = null }
    for (const item of pipes) item.socket.destroy()
  }
  let terminating: Promise<void> | undefined
  const terminate = (): Promise<void> => {
    if (terminating) return terminating
    terminating = (async () => {
      if (valid(job) && assigned) {
        if (!api.terminateJob(job, 1)) failed('TerminateJobObject')
      } else if (valid(processHandle) && api.wait(processHandle, 0) !== 0) {
        if (!api.terminate(processHandle, 1)) failed('TerminateProcess')
      }
      if (monitor) {
        if (!assigned) monitor.cancel()
        // Retain the handles if monitor delivery is interrupted; retries keep this owner reachable.
        await bounded(monitor.done, 5_000, 'language-server native monitor cleanup')
      } else if (valid(processHandle)) {
        // Only partial-start failures use this finite native wait; persistent waits live in the worker.
        const result = await new Promise<number>((resolve, reject) => api.wait.async(processHandle, 5_000, (error: Error | null, value: number) => error ? reject(error) : resolve(value)))
        if (result !== 0) throw new LspError('CLEANUP', `Failed-start process did not exit (wait ${result})`)
      }
      if (valid(processHandle) && api.wait(processHandle, 0) !== 0) throw new LspError('CLEANUP', 'Language-server exit has not been confirmed')
      if (valid(job) && assigned) {
        const accounting = Buffer.alloc(koffi.sizeof(accountingInfo))
        if (!api.queryJob(job, 1, accounting, accounting.length, null)) failed('QueryInformationJobObject')
        if (accounting.readUInt32LE(koffi.offsetof(accountingInfo, 'activeProcesses')) !== 0) throw new LspError('CLEANUP', 'Language-server job still contains active processes')
      }
      release()
    })().catch((error: unknown) => { terminating = undefined; throw error })
    return terminating
  }
  try {
    for (let i = 0; i < 3; i++) pipes.push(await pipe(signal))
    job = api.createJob(null, null) as bigint | null
    if (!valid(job)) failed('CreateJobObjectW')
    const limits = Buffer.alloc(koffi.sizeof(extendedLimits))
    limits.writeUInt32LE(0x2000, koffi.offsetof(basicLimits, 'flags'))
    if (!api.setJob(job, 9, limits, limits.length)) failed('SetInformationJobObject(kill on close)')
    port = api.createPort(invalidHandle, null, 0, 1) as bigint | null
    if (!valid(port)) failed('CreateIoCompletionPort')
    const completion = Buffer.alloc(koffi.sizeof(completionInfo))
    koffi.encode(completion, completionInfo, { key: null, port })
    if (!api.setJob(job, 7, completion, completion.length)) failed('SetInformationJobObject(completion port)')

    // Restrict inheritance to these three pipes, including when other plugins spawn concurrently.
    const size = Buffer.alloc(pointerBytes)
    api.initAttributes(null, 1, 0, size)
    const attributeBytes = Number(koffi.decode(size, 'uintptr'))
    if (!attributeBytes || attributeBytes > 1024 * 1024) failed('InitializeProcThreadAttributeList(size)')
    attributes = koffi.alloc('uint8', attributeBytes) as bigint
    if (!api.initAttributes(attributes, 1, 0, size)) failed('InitializeProcThreadAttributeList')
    attributesInitialized = true
    const inherited = Buffer.alloc(pointerBytes * pipes.length)
    pipes.forEach((item, index) => {
      if (!api.inherit(item.handle, 1, 1)) failed('SetHandleInformation')
      koffi.encode(inherited, pointerBytes * index, 'void *', item.handle)
    })
    if (!api.updateAttributes(attributes, 0, 0x20002, inherited, inherited.length, null, null)) failed('UpdateProcThreadAttribute(handle list)')
    const startupBuffer = Buffer.alloc(koffi.sizeof(startupEx))
    startupBuffer.writeUInt32LE(startupBuffer.length, koffi.offsetof(startup, 'cb'))
    startupBuffer.writeUInt32LE(0x101, koffi.offsetof(startup, 'flags'))
    for (const [index, field] of ['stdin', 'stdout', 'stderr'].entries()) koffi.encode(startupBuffer, koffi.offsetof(startup, field), 'void *', pipes[index]!.handle)
    koffi.encode(startupBuffer, koffi.offsetof(startupEx, 'attributes'), 'void *', attributes)
    const info = Buffer.alloc(koffi.sizeof(processInfo))
    const commandLine = Buffer.from([executable, ...command.slice(1)].map(quote).join(' ') + '\0', 'utf16le')
    checkAbort(signal)
    if (!api.create(executable, commandLine, null, null, 1, 0x08080004, null, cwd, startupBuffer, info)) failed('CreateProcessW')
    const created = koffi.decode(info, processInfo) as { process: bigint; thread: bigint; pid: number }
    processHandle = created.process
    thread = created.thread
    monitor = monitorProcess(processHandle, port)
    if (!api.assign(job, processHandle)) failed('AssignProcessToJobObject')
    assigned = true
    if (api.resume(thread) === 0xffffffff) failed('ResumeThread')
    checkAbort(signal)
    return { pid: created.pid, stdin: pipes[0]!.socket, stdout: pipes[1]!.socket, stderr: pipes[2]!.socket, exited: monitor.exited, terminate }
  } catch (error) {
    try { await terminate() } catch (cleanup) {
      throw new ProcessStartupError(`${message(error)}; startup cleanup remains incomplete: ${message(cleanup)}`, { terminate })
    }
    throw error
  } finally {
    if (valid(thread)) api.close(thread)
    if (attributesInitialized) api.deleteAttributes(attributes)
    if (attributes !== null) koffi.free(attributes)
    for (const item of pipes) api.close(item.handle)
  }
}
