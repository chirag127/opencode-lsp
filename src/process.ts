import { spawn } from 'node:child_process'
import type { Readable, Writable } from 'node:stream'
import { abortable, bounded, checkAbort, LspError } from './errors.js'

export interface ServerProcess {
  readonly pid: number
  readonly stdin: Writable
  readonly stdout: Readable
  readonly stderr: Readable
  readonly exited: Promise<{ code: number | null; signal: string | null }>
  terminate(): Promise<void>
}

export async function spawnServer(command: readonly [string, ...string[]], cwd: string, signal: AbortSignal): Promise<ServerProcess> {
  checkAbort(signal)
  if (process.platform === 'win32') {
    const { spawnWindowsServer } = await import('./windows-process.js')
    checkAbort(signal)
    return spawnWindowsServer(command, cwd, signal)
  }

  const [executable, ...args] = command
  const child = spawn(executable, args, { cwd, stdio: 'pipe', shell: false, detached: true })
  const exited = new Promise<{ code: number | null; signal: string | null }>((resolve) => {
    child.once('exit', (code, signalName) => resolve({ code, signal: signalName }))
    child.once('error', () => resolve({ code: null, signal: null }))
  })
  const spawned = new Promise<void>((resolve, reject) => {
    child.once('spawn', resolve)
    child.once('error', reject)
  })
  let termination: Promise<void> | undefined
  const terminate = (): Promise<void> => {
    if (termination) return termination
    termination = (async () => {
      if (child.pid) {
        try { process.kill(-child.pid, 'SIGKILL') } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
        }
      }
      await bounded(exited, 5_000, 'language-server process exit')
      child.stdin.destroy()
      child.stdout.destroy()
      child.stderr.destroy()
    })().catch((error: unknown) => { termination = undefined; throw error })
    return termination
  }
  try {
    await abortable(spawned, signal)
    checkAbort(signal)
    if (!child.pid) throw new LspError('SPAWN', 'Language server started without a process id')
    return { pid: child.pid, stdin: child.stdin, stdout: child.stdout, stderr: child.stderr, exited, terminate }
  } catch (error) {
    await terminate()
    throw error
  }
}
