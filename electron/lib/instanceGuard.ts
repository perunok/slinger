/**
 * One Slinger per computer user, whatever profile it runs with. Electron's `requestSingleInstanceLock` is per profile
 * (the userData folder), so a Slinger started with another profile (`SLINGER_USER_DATA_DIR`, `--user-data-dir`) would run
 * next to the first. Packaged builds therefore also take this lock: a local socket (a Unix domain socket in the user's
 * private runtime folder, a named pipe on Windows). A second start connects, asks the first to show its window and
 * exits; the first answers and shows it. Plain Node (no Electron), so it is unit-tested with real sockets.
 *
 * A socket file left by a crash is removed only when nothing listens on it (the connection is refused); a Slinger that is
 * merely slow to answer still counts as running, so a busy first instance never lets a second one start.
 *
 * Squatting: another local user must not be able to make Slinger exit by holding the lock first.
 * - POSIX: the socket lives in a directory of its own (`slinger-<uid>/`, created 0700) and is trusted only when that
 *   directory and the socket itself belong to this user (lstat, no symlinks); anything else disables the guard (Slinger
 *   starts) instead of making it quit. `/tmp` is only used when there is no `$XDG_RUNTIME_DIR`.
 * - Windows: the pipe name ends in a hash of a random per-user secret kept in the user's own AppData, so other users cannot
 *   guess it; and a pipe that does not answer the protocol ("ok") is treated as someone else's, not as a running Slinger.
 */
import { createHash, randomBytes } from 'node:crypto'
import { chmodSync, lstatSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { connect, createServer, type Server, type Socket } from 'node:net'
import { dirname, join } from 'node:path'

export interface GuardPathInput {
  platform: NodeJS.Platform
  /** process.getuid?.() on POSIX. */
  uid?: number
  username: string
  /** $XDG_RUNTIME_DIR (Linux): private to the user. */
  runtimeDir?: string
  /** os.tmpdir() (macOS: private to the user). */
  tmpDir: string
  /** Windows: a random per-user secret (guardSecret) that makes the pipe name unguessable for other users. */
  secret?: string
}

/** Where the lock lives for this user. */
export function instanceGuardPath(o: GuardPathInput): string {
  const who = o.uid !== undefined ? String(o.uid) : o.username.replace(/[^A-Za-z0-9._-]/g, '_') || 'user'
  if (o.platform === 'win32') {
    const tag = createHash('sha256').update(`${o.username}\0${o.secret ?? ''}`).digest('hex').slice(0, 32)
    return `\\\\.\\pipe\\slinger-${tag}`
  }
  return join(o.runtimeDir || o.tmpDir, `slinger-${who}`, 'instance.sock')
}

/**
 * The per-user secret for the Windows pipe name: read from `file` (in the user's own AppData), created with 32 random
 * bytes the first time. Falls back to a fresh value (the guard then only works within this start) when it cannot be kept.
 */
export function guardSecret(file: string): string {
  try {
    const existing = readFileSync(file, 'utf8').trim()
    if (/^[0-9a-f]{64}$/.test(existing)) return existing
  } catch {
    /* first start */
  }
  const fresh = randomBytes(32).toString('hex')
  try {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, fresh, { mode: 0o600 })
  } catch {
    /* not writable: this start's own secret */
  }
  return fresh
}

/**
 * POSIX: makes sure `dir` is a private directory of this user (creates it 0700; tightens our own directory's mode).
 * False when it is someone else's, a symlink or not a directory: the lock is then not used.
 */
export function ensurePrivateDir(dir: string, uid: number): boolean {
  try {
    mkdirSync(dir, { mode: 0o700 })
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') return false
  }
  try {
    const st = lstatSync(dir)
    if (!st.isDirectory() || st.uid !== uid) return false
    if ((st.mode & 0o077) !== 0) chmodSync(dir, 0o700)
    return true
  } catch {
    return false
  }
}

/** POSIX: whether `path` is a socket owned by this user ('missing' when there is nothing). */
export function socketOwnership(path: string, uid: number): 'ours' | 'foreign' | 'missing' {
  try {
    const st = lstatSync(path)
    return st.isSocket() && st.uid === uid ? 'ours' : 'foreign'
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'foreign'
  }
}

export type InstanceGuard = { primary: true; close(): void } | { primary: false }

/** How long a second start waits for the first to answer "show" (it exits either way: the first is running). */
const ANSWER_MS = 2000

const NO_GUARD: InstanceGuard = { primary: true, close() {} }

/**
 * Takes the lock, or asks the Slinger that holds it to show its window. `primary: false`: another Slinger runs (quit now).
 * Never blocks starting for any other reason: a lock that cannot be created (permissions, ...) or that belongs to someone
 * else counts as taken by us. `uid` (POSIX; default process.getuid()) is who the directory and socket must belong to.
 */
export async function acquireInstanceGuard(
  path: string,
  onShow: () => void,
  platform: NodeJS.Platform = process.platform,
  uid: number | undefined = process.getuid?.(),
): Promise<InstanceGuard> {
  const posix = platform !== 'win32'
  if (posix && uid !== undefined && !ensurePrivateDir(dirname(path), uid)) return NO_GUARD
  for (let attempt = 0; attempt < 3; attempt++) {
    const server = await listen(path, onShow)
    if (!(server instanceof Error)) {
      return {
        primary: true,
        close: () => {
          server.close()
          if (platform !== 'win32') rmSync(path, { force: true })
        },
      }
    }
    if ((server as NodeJS.ErrnoException).code !== 'EADDRINUSE') return NO_GUARD
    // Only a socket of this user can be a Slinger of this user (and only that one may be removed when stale).
    if (posix && uid !== undefined && socketOwnership(path, uid) === 'foreign') return NO_GUARD
    const other = await askToShow(path, !posix)
    if (other === 'running') return { primary: false }
    if (other === 'foreign') return NO_GUARD
    // Nothing listens there: a socket file left by a crash (named pipes vanish with their process).
    if (posix) rmSync(path, { force: true })
  }
  return NO_GUARD
}

function listen(path: string, onShow: () => void): Promise<Server | Error> {
  return new Promise((resolve) => {
    const server = createServer((socket) => serve(socket, onShow))
    server.once('error', (err) => resolve(err))
    server.listen(path, () => {
      server.removeAllListeners('error')
      server.on('error', () => {})
      resolve(server)
    })
  })
}

function serve(socket: Socket, onShow: () => void): void {
  let text = ''
  socket.setEncoding('utf8')
  socket.on('error', () => {})
  socket.setTimeout(ANSWER_MS, () => socket.destroy())
  socket.on('data', (chunk: string) => {
    text += chunk
    if (text.length > 64) return void socket.destroy()
    if (!text.includes('\n')) return
    if (text.startsWith('show')) onShow()
    socket.end('ok\n')
  })
}

/**
 * 'running': a Slinger listens (it was asked to show its window); 'stale': nothing listens on the path; 'foreign': something
 * answered that is not a Slinger. `strict` (Windows, where the pipe's owner cannot be checked): a silent or closed pipe is
 * 'foreign' too, only an "ok" counts as running.
 */
function askToShow(path: string, strict: boolean): Promise<'running' | 'stale' | 'foreign'> {
  return new Promise((resolve) => {
    let connected = false
    let answer = ''
    let settled = false
    const socket = connect(path)
    const done = (result: 'running' | 'stale' | 'foreign') => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve(result)
    }
    const unanswered = () => done(strict ? 'foreign' : 'running')
    socket.setTimeout(ANSWER_MS, unanswered)
    socket.setEncoding('utf8')
    socket.on('connect', () => {
      connected = true
      socket.write('show\n')
    })
    socket.on('data', (chunk: string) => {
      answer += chunk
      if (answer.length >= 3 || answer.includes('\n')) done(answer.startsWith('ok\n') ? 'running' : 'foreign')
    })
    socket.on('error', (err: NodeJS.ErrnoException) => {
      // Refused or missing: nobody listens. Any other failure after connecting still means someone is there.
      if (!connected && (err.code === 'ECONNREFUSED' || err.code === 'ENOENT' || err.code === 'ENOTSOCK')) done('stale')
      else unanswered()
    })
    socket.on('close', () => {
      if (connected) {
        if (answer) done(answer.startsWith('ok') ? 'running' : 'foreign')
        else unanswered()
      }
    })
  })
}
