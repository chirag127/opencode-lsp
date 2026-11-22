export class LspError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
    this.name = 'LspError'
  }
}

export class ProcessStartupError extends LspError {
  constructor(message: string, readonly cleanupOwner: { terminate(): Promise<void> }) {
    super('STARTUP_CLEANUP', message)
  }
}

export function checkAbort(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason ?? new DOMException('Operation cancelled', 'AbortError')
}

export function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export async function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  let abort: (() => void) | undefined
  const interrupted = new Promise<never>((_, reject) => {
    abort = () => reject(signal.reason ?? new DOMException('Operation cancelled', 'AbortError'))
    if (signal.aborted) abort()
    else signal.addEventListener('abort', abort, { once: true })
  })
  try {
    return await Promise.race([work, interrupted])
  } finally {
    if (abort) signal.removeEventListener('abort', abort)
  }
}

export async function bounded<T>(
  work: Promise<T>,
  milliseconds: number,
  label: string,
  signal?: AbortSignal,
  onCancel?: () => void,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  let abort: (() => void) | undefined
  const interrupt = new Promise<never>((_, reject) => {
    const cancel = (error: unknown) => {
      try { onCancel?.() } catch { /* The original interruption remains the public error. */ }
      reject(error)
    }
    abort = () => cancel(signal?.reason ?? new DOMException('Operation cancelled', 'AbortError'))
    if (signal?.aborted) abort()
    else signal?.addEventListener('abort', abort, { once: true })
    timer = setTimeout(() => cancel(new LspError('TIMEOUT', `${label} timed out after ${milliseconds}ms`)), milliseconds)
  })
  try {
    return await Promise.race([work, interrupt])
  } finally {
    clearTimeout(timer)
    if (abort) signal?.removeEventListener('abort', abort)
  }
}
