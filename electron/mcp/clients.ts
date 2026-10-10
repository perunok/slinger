/**
 * "Connect" for MCP assistants: adds / removes Slinger's entry ("slinger") in their MCP configuration so nothing has to be
 * copied by hand. Every entry is the same secret-free command (McpStatus.stdio): the bridge finds the port and token itself.
 *
 * File-based clients (Claude Desktop, Cursor, VS Code, Windsurf): JSON is read, only our key changes, the previous file
 * is kept as <file>.slinger-backup, the new one is written atomically. Files that are not plain JSON (comments) are left
 * alone with an explanation. Claude Code: its own CLI (`claude mcp add-json --scope user ...`), status from ~/.claude.json.
 * Only ever runs when the user clicks Connect / Disconnect.
 */
import { execFile } from 'node:child_process'
import { access, copyFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { constants } from 'node:fs'
import { delimiter, dirname, join } from 'node:path'
import type { McpClientId, McpClientStatus } from '../../shared/mcp'

export const ENTRY_NAME = 'slinger'

export interface ServerEntry {
  command: string
  args: string[]
  env: Record<string, string>
}

export interface ClientsEnv {
  home: string
  platform: NodeJS.Platform
  /** %APPDATA% on Windows; ~/Library/Application Support on macOS; ~/.config on Linux. */
  appData: string
  /** Finds an executable (PATH, the usual install places, the login shell). */
  findExecutable(name: string): Promise<string | null>
  run(command: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }>
}

export class ClientConfigError extends Error {}

interface FileClient {
  id: McpClientId
  name: string
  kind: 'file'
  /** Its existence means the assistant is installed. */
  detectDir: string
  file: string
  key: 'mcpServers' | 'servers'
  /** VS Code wants `type: "stdio"`. */
  typed: boolean
  afterConnect: string
}

function fileClients(env: ClientsEnv): FileClient[] {
  const { home, platform, appData } = env
  const claudeDir = platform === 'linux' ? join(home, '.config', 'Claude') : join(appData, 'Claude')
  const codeUser = platform === 'linux' ? join(home, '.config', 'Code', 'User') : join(appData, 'Code', 'User')
  return [
    {
      id: 'claude-desktop',
      name: 'Claude Desktop',
      kind: 'file',
      detectDir: claudeDir,
      file: join(claudeDir, 'claude_desktop_config.json'),
      key: 'mcpServers',
      typed: false,
      afterConnect: 'Quit Claude Desktop completely and open it again.',
    },
    {
      id: 'cursor',
      name: 'Cursor',
      kind: 'file',
      detectDir: join(home, '.cursor'),
      file: join(home, '.cursor', 'mcp.json'),
      key: 'mcpServers',
      typed: false,
      afterConnect: 'Cursor picks it up by itself; if not, restart Cursor.',
    },
    {
      id: 'vscode',
      name: 'VS Code',
      kind: 'file',
      detectDir: codeUser,
      file: join(codeUser, 'mcp.json'),
      key: 'servers',
      typed: true,
      afterConnect: 'In VS Code, start "slinger" from the MCP servers list (Copilot Chat, agent mode).',
    },
    {
      id: 'windsurf',
      name: 'Windsurf',
      kind: 'file',
      detectDir: join(home, '.codeium', 'windsurf'),
      file: join(home, '.codeium', 'windsurf', 'mcp_config.json'),
      key: 'mcpServers',
      typed: false,
      afterConnect: 'Refresh the MCP servers in Windsurf (or restart it).',
    },
  ]
}

const exists = (p: string) =>
  access(p, constants.F_OK).then(
    () => true,
    () => false,
  )

async function readConfig(file: string): Promise<Record<string, unknown>> {
  let text: string
  try {
    text = await readFile(file, 'utf8')
  } catch {
    return {}
  }
  if (!text.trim()) return {}
  try {
    const parsed: unknown = JSON.parse(text)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>
  } catch {
    /* fall through */
  }
  throw new ClientConfigError(`${file} is not plain JSON (it may contain comments), so Slinger leaves it alone. Add Slinger by hand (Other assistants).`)
}

async function writeConfig(file: string, config: Record<string, unknown>): Promise<void> {
  await mkdir(dirname(file), { recursive: true })
  if (await exists(file)) await copyFile(file, `${file}.slinger-backup`)
  const tmp = `${file}.${process.pid}.slinger-tmp`
  await writeFile(tmp, `${JSON.stringify(config, null, 2)}\n`)
  await rename(tmp, file)
}

function stateOf(entry: unknown, expected: ServerEntry): McpClientStatus['state'] {
  if (!entry || typeof entry !== 'object') return 'not-connected'
  const e = entry as { command?: unknown; args?: unknown; env?: Record<string, unknown> }
  const same =
    e.command === expected.command &&
    JSON.stringify(e.args ?? []) === JSON.stringify(expected.args) &&
    Object.entries(expected.env).every(([k, v]) => e.env?.[k] === v)
  return same ? 'connected' : 'outdated'
}

const servers = (config: Record<string, unknown>, key: string): Record<string, unknown> => {
  const s = config[key]
  return s && typeof s === 'object' && !Array.isArray(s) ? (s as Record<string, unknown>) : {}
}

const claudeCodeConfig = (env: ClientsEnv) => join(env.home, '.claude.json')

export async function listClients(env: ClientsEnv, expected: ServerEntry): Promise<McpClientStatus[]> {
  const out: McpClientStatus[] = []
  for (const c of fileClients(env)) {
    let state: McpClientStatus['state'] = 'not-connected'
    try {
      state = stateOf(servers(await readConfig(c.file), c.key)[ENTRY_NAME], expected)
    } catch {
      /* unreadable: shown as not connected; Connect explains */
    }
    out.push({ id: c.id, name: c.name, installed: await exists(c.detectDir), state, configPath: c.file, afterConnect: c.afterConnect })
  }
  const claude = await env.findExecutable('claude')
  let state: McpClientStatus['state'] = 'not-connected'
  try {
    state = stateOf(servers(await readConfig(claudeCodeConfig(env)), 'mcpServers')[ENTRY_NAME], expected)
  } catch {
    /* unreadable */
  }
  out.splice(1, 0, {
    id: 'claude-code',
    name: 'Claude Code',
    installed: claude !== null,
    state,
    configPath: claude,
    afterConnect: 'Start a new Claude Code session (claude) to use it.',
  })
  return out
}

export async function connectClient(env: ClientsEnv, id: McpClientId, expected: ServerEntry): Promise<void> {
  if (id === 'claude-code') return connectClaudeCode(env, expected)
  const c = fileClients(env).find((x) => x.id === id)!
  const config = await readConfig(c.file)
  const entry = c.typed ? { type: 'stdio', ...expected } : { ...expected }
  config[c.key] = { ...servers(config, c.key), [ENTRY_NAME]: entry }
  await writeConfig(c.file, config)
}

export async function disconnectClient(env: ClientsEnv, id: McpClientId): Promise<void> {
  if (id === 'claude-code') return disconnectClaudeCode(env)
  const c = fileClients(env).find((x) => x.id === id)!
  const config = await readConfig(c.file)
  const s = servers(config, c.key)
  if (!(ENTRY_NAME in s)) return
  const { [ENTRY_NAME]: _, ...rest } = s
  config[c.key] = rest
  await writeConfig(c.file, config)
}

async function connectClaudeCode(env: ClientsEnv, expected: ServerEntry): Promise<void> {
  const claude = await env.findExecutable('claude')
  if (!claude) throw new ClientConfigError('Claude Code (the `claude` command) was not found. Install it, or add Slinger by hand.')
  // Replace whatever "slinger" entry there is (e.g. one for an older Slinger location).
  await env.run(claude, ['mcp', 'remove', '--scope', 'user', ENTRY_NAME]).catch(() => null)
  // add-json takes the whole entry as one argument (`add -e` is variadic and would swallow the server name).
  const json = JSON.stringify({ type: 'stdio', command: expected.command, args: expected.args, env: expected.env })
  const res = await env.run(claude, ['mcp', 'add-json', '--scope', 'user', ENTRY_NAME, json])
  if (res.code !== 0) throw new ClientConfigError(`claude mcp add-json failed: ${(res.stderr || res.stdout).trim().slice(0, 500)}`)
}

async function disconnectClaudeCode(env: ClientsEnv): Promise<void> {
  const claude = await env.findExecutable('claude')
  if (!claude) throw new ClientConfigError('Claude Code (the `claude` command) was not found.')
  const res = await env.run(claude, ['mcp', 'remove', '--scope', 'user', ENTRY_NAME])
  if (res.code !== 0 && !/not found|no .*server/i.test(res.stderr + res.stdout)) {
    throw new ClientConfigError(`claude mcp remove failed: ${(res.stderr || res.stdout).trim().slice(0, 500)}`)
  }
}

// ---- the real environment ----------------------------------------------------------------------------------------

/** Apps started from the desktop do not get the shell's PATH, so the usual install places and the login shell are tried too. */
export function defaultClientsEnv(home: string, platform: NodeJS.Platform, appData: string, pathEnv = process.env.PATH ?? ''): ClientsEnv {
  const win = platform === 'win32'
  const exts = win ? ['.exe', '.cmd', '.bat', ''] : ['']
  const extraDirs = win
    ? [join(appData, 'npm'), join(home, '.local', 'bin'), join(home, 'AppData', 'Local', 'Programs', 'claude')]
    : [join(home, '.local', 'bin'), join(home, '.claude', 'local'), join(home, '.npm-global', 'bin'), join(home, '.bun', 'bin'), '/usr/local/bin', '/opt/homebrew/bin', '/usr/bin']
  const run: ClientsEnv['run'] = (command, args) =>
    new Promise((resolve) => {
      // .cmd shims (npm on Windows) only start through a shell.
      const shell = win && /\.(cmd|bat)$/i.test(command)
      const argv = shell ? args.map((a) => `"${a.replace(/"/g, '""')}"`) : args
      execFile(shell ? `"${command}"` : command, argv, { timeout: 30_000, windowsHide: true, shell, env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined } }, (err, stdout, stderr) => {
        const code = err ? (typeof (err as { code?: unknown }).code === 'number' ? ((err as { code: number }).code) : 1) : 0
        resolve({ code, stdout: String(stdout), stderr: String(stderr) || (err && code === 1 ? err.message : '') })
      })
    })
  // Remembered for a minute: installing Claude Code while Slinger is open shows up on the next look.
  const cache = new Map<string, { at: number; hit: Promise<string | null> }>()
  const findExecutable = (name: string) => {
    const cached = cache.get(name)
    let hit = cached && Date.now() - cached.at < 60_000 ? cached.hit : undefined
    if (!hit) {
      hit = (async () => {
        for (const dir of [...pathEnv.split(delimiter).filter(Boolean), ...extraDirs]) {
          for (const ext of exts) {
            const p = join(dir, name + ext)
            try {
              await access(p, win ? constants.F_OK : constants.X_OK)
              return p
            } catch {
              /* next */
            }
          }
        }
        if (win) return null
        // Last resort: ask the user's login shell (nvm, asdf, custom PATH in .profile).
        const shell = process.env.SHELL || '/bin/sh'
        const res = await new Promise<string>((resolve) =>
          execFile(shell, ['-lc', `command -v ${name}`], { timeout: 4000 }, (_e, stdout) => resolve(String(stdout ?? '').trim())),
        )
        return res.startsWith('/') ? res.split('\n')[0]! : null
      })()
      cache.set(name, { at: Date.now(), hit })
    }
    return hit
  }
  return { home, platform, appData, findExecutable, run }
}
