/**
 * The folder connected assistants use: <userData>/mcp/
 *
 *   bridge.cjs     the stdio bridge (copied from dist-electron/mcp-stdio.cjs on every start, so it follows app updates
 *                  and works for AppImages, whose own files move on every launch)
 *   launch.json    how to start Slinger, whether the server is on and whether the user quit it (no secrets)
 *   endpoint.json  URL + token of the running server; only while it is on; readable by the user only (0600)
 */
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ENDPOINT_FILE, LAUNCH_FILE, type Endpoint, type Launch } from './stdioBridge'

export const BRIDGE_FILE = 'bridge.cjs'

export class McpFiles {
  readonly dir: string

  constructor(userDataDir: string) {
    this.dir = join(userDataDir, 'mcp')
  }

  get bridgePath(): string {
    return join(this.dir, BRIDGE_FILE)
  }

  /** Copies the bridge script (when it changed) and writes launch.json. Never throws: assistants then just cannot start Slinger. */
  prepare(bridgeSource: string | null, launch: Launch): void {
    try {
      mkdirSync(this.dir, { recursive: true })
      if (bridgeSource) {
        const code = readFileSync(bridgeSource, 'utf8')
        let current: string | null = null
        try {
          current = readFileSync(this.bridgePath, 'utf8')
        } catch {
          /* first time */
        }
        if (current !== code) this.#write(BRIDGE_FILE, code, 0o644)
      }
      this.#write(LAUNCH_FILE, `${JSON.stringify(launch, null, 2)}\n`, 0o644)
    } catch (e) {
      console.warn(`MCP: could not prepare ${this.dir}: ${(e as Error).message}`)
    }
  }

  writeLaunch(launch: Launch): void {
    try {
      mkdirSync(this.dir, { recursive: true })
      this.#write(LAUNCH_FILE, `${JSON.stringify(launch, null, 2)}\n`, 0o644)
    } catch (e) {
      console.warn(`MCP: could not write ${LAUNCH_FILE}: ${(e as Error).message}`)
    }
  }

  writeEndpoint(endpoint: Endpoint): void {
    try {
      mkdirSync(this.dir, { recursive: true })
      this.#write(ENDPOINT_FILE, `${JSON.stringify(endpoint)}\n`, 0o600)
    } catch (e) {
      console.warn(`MCP: could not write ${ENDPOINT_FILE}: ${(e as Error).message}`)
    }
  }

  removeEndpoint(): void {
    rmSync(join(this.dir, ENDPOINT_FILE), { force: true })
  }

  /** Atomic replace (temp file + rename) with the given permissions (ignored on Windows, where the profile is private). */
  #write(name: string, text: string, mode: number): void {
    const target = join(this.dir, name)
    const tmp = `${target}.${process.pid}.tmp`
    writeFileSync(tmp, text, { mode })
    chmodSync(tmp, mode)
    renameSync(tmp, target)
  }
}
