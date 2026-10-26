import { toast } from './toast.svelte'

/** Puts `text` on the clipboard and confirms it with a toast (or says why it could not). */
export async function copyText(text: string, title = 'Copied to clipboard', detail?: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    toast.success(title, detail)
    return true
  } catch {
    toast.error('Could not copy', 'Clipboard access was denied.')
    return false
  }
}
