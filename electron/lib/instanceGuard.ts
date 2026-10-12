/**
 * One Slinger per computer user, whatever profile it runs with. Electron's `requestSingleInstanceLock` is per profile
 * (the userData folder), so a Slinger started with another profile (`SLINGER_USER_DATA_DIR`, `--user-data-dir`) would run
 * next to the first. Packaged builds therefore also take this lock: a local socket (a Unix domain socket in the user's
 * private runtime folder, a named pipe on Windows). A second start connects, asks the first to show its window and
 * exits; the first answers and shows it. Plain Node (no Electron), so it is unit-tested with real sockets.
 *
 * A socket file left by a crash is removed only when nothing listens on it (the connection is refused); a Slinger that is
 * merely slow to answer still counts as running, so a busy first instance never lets a second one start.
 */
import { rmSync } from 'node:fs'
import { connect, createServer, type Server, type Socket } from 'node:net'
import { join } from 'node:path'

export interface GuardPathInput {
  platform: NodeJS.Platform
  /** process.getuid?.() on POSIX. */
  uid?: number
  username: string
  /** $XDG_RUNTIME_DIR (Linux): private to the user. */
  runtimeDir?: string
  /** os.tmpdir() (macOS: private to the user). */
  tmpDir: string
}

/** Where the lock lives for this user. */
export function instanceGuardPath(o: GuardPathInput): string {
  const who = o.uid !== undefined ? String(o.uid) : o.username.replace(/[^A-Za-z0-9._-]/g, '_') || 'user'
  if (o.platform === 'win32') return `\\\\.\\pipe\\slinger-${who}`
  return join(o.runtimeDir || o.tmpDir, `slinger-${who}.sock`)
}

export type InstanceGuard = { primary: true; close(): void } | { primary: false }

/** How long a second start waits for the first to answer "show" (it exits either way: the first is running). */
const ANSWER_MS = 2000

/**
 * Takes the lock, or asks the Slinger that holds it to show its window. `primary: false`: another Slinger runs (quit now).
 * Never blocks starting for any other reason: a lock that cannot be created (permissions, ...) counts as taken by us.
 */
export async function acquireInstanceGuard(path: string, onShow: () => void, platform: NodeJS.Platform = process.platform): Promise<InstanceGuard> {
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
    if ((server as NodeJS.ErrnoException).code !== 'EADDRINUSE') return { primary: true, close() {} }
    const other = await askToShow(path)
    if (other === 'running') return { primary: false }
    // Nothing listens there: a socket file left by a crash (named pipes vanish with their process).
    if (platform !== 'win32') rmSync(path, { force: true })
  }
  return { primary: true, close() {} }
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

/** 'running': something listens (it was asked to show its window); 'stale': nothing listens on the path. */
function askToShow(path: string): Promise<'running' | 'stale'> {
  return new Promise((resolve) => {
    let connected = false
    const socket = connect(path)
    const done = (result: 'running' | 'stale') => {
      socket.destroy()
      resolve(result)
    }
    socket.setTimeout(ANSWER_MS, () => done('running'))
    socket.on('connect', () => {
      connected = true
      socket.write('show\n')
    })
    socket.on('data', () => done('running'))
    socket.on('error', (err: NodeJS.ErrnoException) => {
      // Refused or missing: nobody listens. Any other failure after connecting still means someone is there.
      if (!connected && (err.code === 'ECONNREFUSED' || err.code === 'ENOENT' || err.code === 'ENOTSOCK')) done('stale')
      else done('running')
    })
    socket.on('close', () => {
      if (connected) done('running')
    })
  })
}
