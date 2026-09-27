<script lang="ts">
  /**
   * Import a custom theme from a `.slinger-theme.json` file or pasted CSS / JSON. The input is untrusted and goes through
   * the same validation as the editor (lib/customThemes.ts parseThemeImport); the result opens in the editor for review.
   */
  import Button from '../../components/ui/Button.svelte'
  import Dialog from '../../components/ui/Dialog.svelte'
  import { MAX_THEME_TEXT_LENGTH, THEME_FILE_EXT, parseThemeImport, type CustomThemeData } from '../../lib/customThemes'

  interface Props {
    onclose: () => void
    onimport: (theme: CustomThemeData, warnings: string[]) => void
  }
  let { onclose, onimport }: Props = $props()

  let input = $state<HTMLInputElement>()
  let pasted = $state('')
  let errors = $state<string[]>([])
  let fileName = $state<string | null>(null)

  function readFile(file: File): Promise<string> {
    if (typeof file.text === 'function') return file.text()
    return new Promise((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(String(reader.result ?? ''))
      reader.onerror = () => reject(reader.error)
      reader.readAsText(file)
    })
  }

  function run(text: string, label: string) {
    const r = parseThemeImport(text, undefined, label)
    errors = r.errors
    if (r.theme) onimport(r.theme, r.warnings)
  }

  async function load(file: File | null | undefined) {
    if (!file) return
    fileName = file.name
    if (file.size > MAX_THEME_TEXT_LENGTH) {
      errors = [`${file.name} is too large for a theme (at most ${MAX_THEME_TEXT_LENGTH / 1000} KB).`]
      return
    }
    try {
      const stem = file.name.replace(/\.slinger-theme\.json$|\.json$|\.css$/i, '')
      run(await readFile(file), stem || 'Imported theme')
    } catch {
      errors = [`Could not read ${file.name}.`]
    }
  }
</script>

<Dialog title="Import theme" {onclose} size="md">
  <div class="flex flex-col gap-3 text-sm">
    <p class="-mt-1 text-xs text-muted">A Slinger theme file ({THEME_FILE_EXT}) or CSS declarations such as <code>--bg: #rrggbb;</code>. You can review it before saving.</p>
    <div class="flex items-center gap-2">
      <input
        bind:this={input}
        type="file"
        accept={`${THEME_FILE_EXT},.json,.css,application/json,text/css`}
        class="sr-only"
        aria-label="Theme file"
        onchange={(e) => load(e.currentTarget.files?.[0])}
      />
      <Button icon="upload" onclick={() => input?.click()}>Choose file</Button>
      {#if fileName}<span class="truncate text-xs text-muted">{fileName}</span>{/if}
    </div>
    <label class="grid gap-1">
      <span class="text-xs font-medium">Or paste CSS or JSON</span>
      <textarea rows="8" class="font-mono text-xs" bind:value={pasted} aria-label="Theme CSS or JSON" spellcheck="false"></textarea>
    </label>
    {#if errors.length}
      <ul class="grid gap-0.5 rounded border border-danger bg-danger-soft px-2 py-1.5 text-xs" role="alert" aria-label="Import errors">
        {#each errors as e, i (i)}<li>{e}</li>{/each}
      </ul>
    {/if}
  </div>
  {#snippet footer()}
    <Button onclick={onclose}>Cancel</Button>
    <Button variant="primary" disabled={!pasted.trim()} onclick={() => run(pasted, 'Imported theme')}>Import pasted text</Button>
  {/snippet}
</Dialog>
