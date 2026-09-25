export interface SyncItServer {
  baseUrl: string
  adminEmail: string
  adminPassword: string
  databaseUrl: string
  container: string | null
  log(): string
  dump(): string
  stop(): Promise<void>
}
export function startSyncItServer(opts?: { serverDir?: string; databaseUrl?: string; env?: Record<string, string> }): Promise<SyncItServer>
