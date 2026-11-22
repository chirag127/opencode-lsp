import { constants } from 'node:fs'
import { open, realpath, stat } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { checkAbort, LspError } from './errors.js'

const MAX_FILE_BYTES = 2 * 1024 * 1024

export function samePath(left: string, right: string): boolean {
  return path.relative(left, right) === ''
}

export function contains(root: string, file: string): boolean {
  const relative = path.relative(root, file)
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`))
}

function internal(root: string, file: string): void {
  if (!contains(root, file)) throw new LspError('OUTSIDE_ROOT', 'The path is outside the configured language-server root or active location')
}

export interface ResolvedFile {
  readonly file: string
  readonly requested: string
  readonly resources: readonly string[]
}

export class Paths {
  private constructor(readonly location: string, readonly root: string, readonly requestedRoot: string) {}

  static async create(location: string, configuredRoot: string): Promise<Paths> {
    const canonicalLocation = await realpath(location)
    const requestedRoot = path.resolve(canonicalLocation, configuredRoot)
    internal(canonicalLocation, requestedRoot)
    const root = await realpath(requestedRoot)
    internal(canonicalLocation, root)
    if (!(await stat(root)).isDirectory()) throw new LspError('ROOT', 'The configured language-server root must be a directory')
    return new Paths(canonicalLocation, root, requestedRoot)
  }

  resource(file: string): string {
    internal(this.location, file)
    return path.relative(this.location, file).split(path.sep).join('/') || '.'
  }

  async resolve(input: string): Promise<ResolvedFile> {
    if (!input || /[\u0000\r\n]/u.test(input)) throw new LspError('PATH', 'A nonempty local file path is required')
    const requested = path.resolve(this.location, input)
    internal(this.location, requested)
    if (!contains(this.root, requested) && !contains(this.requestedRoot, requested)) internal(this.root, requested)
    const file = await realpath(requested)
    internal(this.location, file)
    internal(this.root, file)
    return { file, requested, resources: [...new Set([this.resource(requested), this.resource(file)])] }
  }

  async resolveUri(uri: string): Promise<ResolvedFile> {
    let file: string
    try {
      const url = new URL(uri)
      if (url.protocol !== 'file:' || url.search || url.hash) throw new Error('Not a local file URI')
      file = fileURLToPath(url)
    } catch {
      throw new LspError('OUTSIDE_ROOT', 'The server returned a non-local file URI')
    }
    return this.resolve(file)
  }

  async read(resolved: ResolvedFile, signal: AbortSignal): Promise<string> {
    checkAbort(signal)
    // A permission prompt can outlive a symlink. Resolve again after permission is granted.
    const current = await this.resolve(resolved.requested)
    if (!samePath(current.file, resolved.file)) throw new LspError('PATH_CHANGED', 'File destination changed while permission was being checked; retry the tool')
    if (!samePath(await realpath(this.requestedRoot), this.root)) throw new LspError('PATH_CHANGED', 'Configured root changed while permission was being checked')
    const handle = await open(current.file, constants.O_RDONLY | (process.platform === 'win32' ? 0 : constants.O_NOFOLLOW))
    try {
      const info = await handle.stat()
      if (!info.isFile()) throw new LspError('FILE', 'Language-server tools require a regular file')
      if (info.size > MAX_FILE_BYTES) throw new LspError('FILE_LIMIT', 'Language-server documents are limited to 2 MiB')
      const buffer = Buffer.alloc(Math.min(info.size + 1, MAX_FILE_BYTES + 1))
      let used = 0
      while (used < buffer.length) {
        checkAbort(signal)
        const { bytesRead } = await handle.read(buffer, used, buffer.length - used, null)
        if (bytesRead === 0) break
        used += bytesRead
      }
      if (used > info.size || used > MAX_FILE_BYTES) throw new LspError('FILE_CHANGED', 'File grew during its read; retry the tool')
      const after = await this.resolve(resolved.requested)
      const currentInfo = await stat(after.file)
      if (!samePath(after.file, current.file) || currentInfo.dev !== info.dev || currentInfo.ino !== info.ino) throw new LspError('PATH_CHANGED', 'File destination changed during its read; retry the tool')
      const text = buffer.subarray(0, used).toString('utf8')
      if (text.includes('\u0000')) throw new LspError('FILE', 'Binary documents are not supported')
      checkAbort(signal)
      return text
    } finally {
      await handle.close()
    }
  }
}
