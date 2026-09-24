import { errorInfo } from '../../lib/ipc'
/** Reactive cloud state for the dialog: config, signed-in user, remote workspaces, link status. */
import { app } from '../../app/state.svelte'
import { CloudClient } from './client'
import { getLink, isValidBaseUrl, loadConfig, normalizeBaseUrl, saveConfig, setLink } from './config'
import { clearTokens, loadTokens, saveTokens } from './session'
import { CloudApiError, type CloudConfig, type CloudUser, type CloudWorkspace, type Tokens, type WorkspaceLink } from './types'

const msg = (e: unknown) => errorInfo(e).message

class CloudStore {
  config = $state<CloudConfig>(loadConfig())
  status = $state<'unknown' | 'signedOut' | 'signedIn'>('unknown')
  user = $state<CloudUser | null>(null)
  workspaces = $state<CloudWorkspace[]>([])
  busy = $state(false)
  error = $state<string | null>(null)
  /** Bumped on link changes so `link` re-derives (localStorage is not reactive). */
  #linkTick = $state(0)

  link = $derived.by<WorkspaceLink | null>(() => {
    void this.#linkTick
    const id = app.workspaceId
    return id ? getLink(this.config.apiBaseUrl, id) : null
  })

  client(): CloudClient {
    return new CloudClient({
      baseUrl: this.config.apiBaseUrl,
      workspaceId: app.workspaceId ?? '',
      onSignedOut: () => this.#markSignedOut(),
    })
  }

  #markSignedOut() {
    this.status = 'signedOut'
    this.user = null
    this.workspaces = []
  }

  async #run(fn: () => Promise<void>): Promise<boolean> {
    this.busy = true
    this.error = null
    try {
      await fn()
      return true
    } catch (e) {
      this.error = msg(e)
      return false
    } finally {
      this.busy = false
    }
  }

  /** Called when the dialog opens: restore session from the keychain. */
  async init() {
    this.config = loadConfig()
    await this.#run(async () => {
      const tokens = await loadTokens(this.config.apiBaseUrl)
      if (!tokens) return this.#markSignedOut()
      try {
        this.user = await this.client().me()
        this.status = 'signedIn'
      } catch (e) {
        if (e instanceof CloudApiError && e.status !== 0) return this.#markSignedOut()
        this.status = 'signedIn' // offline: keep the session, show the error
        throw e
      }
      this.workspaces = await this.client().listWorkspaces()
    })
  }

  /** Validates and persists config. Returns false (with `error` set) when invalid. */
  applyConfig(c: CloudConfig): boolean {
    if (!isValidBaseUrl(c.apiBaseUrl)) {
      this.error = 'API base URL must start with http:// or https://'
      return false
    }
    this.error = null
    this.config = { apiBaseUrl: normalizeBaseUrl(c.apiBaseUrl), deviceName: c.deviceName.trim() || 'Slinger Desktop' }
    saveConfig(this.config)
    return true
  }

  async completeSignIn(tokens: Tokens) {
    await saveTokens(this.config.apiBaseUrl, tokens)
    await this.#run(async () => {
      this.user = await this.client().me()
      this.status = 'signedIn'
      this.workspaces = await this.client().listWorkspaces()
    })
  }

  async signOut() {
    await this.#run(async () => {
      const tokens = await loadTokens(this.config.apiBaseUrl)
      if (tokens) await this.client().logout(tokens.refreshToken).catch(() => undefined)
      await clearTokens(this.config.apiBaseUrl)
      this.#markSignedOut()
    })
  }

  async refreshWorkspaces() {
    await this.#run(async () => {
      this.workspaces = await this.client().listWorkspaces()
    })
  }

  #setLink(remote: CloudWorkspace | null, localId = app.workspaceId) {
    if (!localId) return
    setLink(this.config.apiBaseUrl, localId, remote && { remoteId: remote.id, remoteName: remote.name })
    this.#linkTick++
  }
  linkTo(remote: CloudWorkspace) {
    this.#setLink(remote)
  }
  unlink() {
    this.#setLink(null)
  }

  /** Creates a remote workspace named after the local one and links it. Does NOT upload content. */
  async publish() {
    const local = app.workspace
    if (!local) return
    await this.#run(async () => {
      const created = await this.client().createWorkspace(local.name)
      this.#setLink(created, local.id)
      this.workspaces = await this.client().listWorkspaces()
    })
  }
}

export const cloud = new CloudStore()
