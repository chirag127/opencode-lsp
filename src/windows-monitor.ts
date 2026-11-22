import { parentPort, workerData } from 'node:worker_threads'
import koffi from 'koffi'

const { processHandle, port, stopMessage } = workerData as { processHandle: bigint; port: bigint; stopMessage: number }

try {
  const kernel = koffi.load('kernel32.dll')
  const wait = kernel.func('uint32 __stdcall WaitForSingleObject(void *handle, uint32 milliseconds)')
  const exitCode = kernel.func('int __stdcall GetExitCodeProcess(void *process, void *code)')
  const next = kernel.func('int __stdcall GetQueuedCompletionStatus(void *port, void *bytes, void *key, void *overlapped, uint32 milliseconds)')
  const error = kernel.func('uint32 __stdcall GetLastError()')
  // Synchronous native waits occupy this dedicated JS thread, never the host's shared libuv pool.
  if (wait(processHandle, 0xffffffff) !== 0) throw new Error(`WaitForSingleObject failed (Win32 ${error()})`)
  const code = Buffer.alloc(4)
  if (!exitCode(processHandle, code)) throw new Error(`GetExitCodeProcess failed (Win32 ${error()})`)
  parentPort!.postMessage({ type: 'exited', code: code.readUInt32LE() })
  const bytes = Buffer.alloc(4)
  const key = Buffer.alloc(koffi.sizeof('void *'))
  const overlapped = Buffer.alloc(koffi.sizeof('void *'))
  for (;;) {
    if (!next(port, bytes, key, overlapped, 0xffffffff)) throw new Error(`GetQueuedCompletionStatus failed (Win32 ${error()})`)
    if (bytes.readUInt32LE() === 4 || bytes.readUInt32LE() === stopMessage) break
  }
} catch (error) {
  parentPort!.postMessage({ type: 'error', message: error instanceof Error ? error.message : String(error) })
} finally {
  parentPort!.close()
}
