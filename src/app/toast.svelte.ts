export type ToastKind = 'error' | 'success' | 'info'
export interface ToastItem {
  id: number
  kind: ToastKind
  title: string
  detail?: string
}

class ToastStore {
  items = $state<ToastItem[]>([])
  #next = 1

  push(kind: ToastKind, title: string, detail?: string, ms?: number): number {
    const id = this.#next++
    this.items = [...this.items, { id, kind, title, detail }]
    const timeout = ms ?? (kind === 'error' ? 9000 : 3500)
    if (timeout > 0) setTimeout(() => this.dismiss(id), timeout)
    return id
  }
  error(title: string, detail?: string) {
    return this.push('error', title, detail)
  }
  success(title: string, detail?: string) {
    return this.push('success', title, detail)
  }
  info(title: string, detail?: string) {
    return this.push('info', title, detail)
  }
  dismiss(id: number) {
    this.items = this.items.filter((t) => t.id !== id)
  }
  clear() {
    this.items = []
  }
}

export const toast = new ToastStore()
