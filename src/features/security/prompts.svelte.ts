/**
 * Questions the window asks before something security-relevant happens during a send: running the scripts of a
 * collection that was imported or synced in (script trust, migration 0019), and sending a stored OAuth 2.0 token to an
 * origin it was not used with. `SecurityPromptHost` (mounted by App) shows them one at a time; asking again while the
 * same question is open waits for the same answer (a collection run asks once, not per request).
 */
export interface SecurityPrompt {
  id: number
  key: string
  title: string
  message: string
  confirmLabel: string
}

class SecurityPrompts {
  queue = $state<SecurityPrompt[]>([])
  private waiting = new Map<string, { promise: Promise<boolean>; resolve: (ok: boolean) => void; id: number }>()
  private nextId = 1

  get current(): SecurityPrompt | null {
    return this.queue[0] ?? null
  }

  ask(key: string, prompt: Omit<SecurityPrompt, 'id' | 'key'>): Promise<boolean> {
    const open = this.waiting.get(key)
    if (open) return open.promise
    const id = this.nextId++
    let resolve!: (ok: boolean) => void
    const promise = new Promise<boolean>((r) => (resolve = r))
    this.waiting.set(key, { promise, resolve, id })
    this.queue = [...this.queue, { ...prompt, id, key }]
    return promise
  }

  /** Answers prompt `id`; a prompt that was already answered is ignored. */
  answer(id: number, ok: boolean): void {
    const p = this.queue.find((q) => q.id === id)
    if (!p) return
    this.queue = this.queue.filter((q) => q.id !== id)
    const w = this.waiting.get(p.key)
    if (w?.id === id) {
      this.waiting.delete(p.key)
      w.resolve(ok)
    }
  }
}

export const securityPrompts = new SecurityPrompts()
