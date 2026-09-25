<script lang="ts">
  /**
   * A thumbnail of the app (sidebar, URL bar, JSON response) drawn with a theme's own tokens: the element carries
   * `data-theme` (and `data-accent`), so every var() below resolves to that palette, not the active one.
   */
  interface Props {
    theme: string
    /** null = the theme's own accent */
    accent?: string | null
  }
  let { theme, accent = null }: Props = $props()

  // [token, width] segments per JSON line: "key": value
  const lines: [string, number][][] = [
    [['syn-punct', 1]],
    [['syn-property', 5], ['syn-punct', 1], ['syn-string', 8]],
    [['syn-property', 4], ['syn-punct', 1], ['syn-number', 3]],
    [['syn-property', 6], ['syn-punct', 1], ['syn-bool', 4]],
  ]
</script>

<span
  data-theme={theme}
  data-accent={accent ?? undefined}
  class="flex h-[4.5rem] w-full overflow-hidden rounded border"
  style="background: var(--bg); border-color: var(--border)"
  aria-hidden="true"
>
  <!-- sidebar: collection tree with the selected row -->
  <span class="flex w-[28%] flex-col gap-[3px] border-r p-1" style="background: var(--surface-raised); border-color: var(--border)">
    <span class="h-[3px] w-3/5 rounded-sm" style="background: var(--text-muted)"></span>
    <span class="flex h-[9px] items-center gap-[2px] rounded-sm px-[2px]" style="background: var(--accent-soft)">
      <span class="h-[3px] w-1.5 rounded-sm" style="background: var(--m-get)"></span>
      <span class="h-[3px] flex-1 rounded-sm" style="background: var(--text)"></span>
    </span>
    <span class="flex items-center gap-[2px] px-[2px]">
      <span class="h-[3px] w-1.5 rounded-sm" style="background: var(--m-post)"></span>
      <span class="h-[3px] w-3/5 rounded-sm" style="background: var(--text-faint)"></span>
    </span>
    <span class="flex items-center gap-[2px] px-[2px]">
      <span class="h-[3px] w-1.5 rounded-sm" style="background: var(--m-delete)"></span>
      <span class="h-[3px] w-1/2 rounded-sm" style="background: var(--text-faint)"></span>
    </span>
  </span>
  <!-- main: URL bar + response -->
  <span class="flex min-w-0 flex-1 flex-col gap-[3px] p-1" style="background: var(--surface)">
    <span class="flex items-center gap-[3px]">
      <span class="h-[7px] flex-1 rounded-sm border" style="border-color: var(--border); background: var(--bg)"></span>
      <span class="h-[7px] w-4 rounded-sm" style="background: var(--accent)"></span>
    </span>
    <span class="flex items-center gap-[3px]">
      <span class="h-[5px] w-3 rounded-sm" style="background: var(--success-soft); box-shadow: inset 0 0 0 1px var(--success)"></span>
      <span class="h-[3px] w-5 rounded-sm" style="background: var(--text-muted)"></span>
    </span>
    {#each lines as line, i (i)}
      <span class="flex gap-[2px]" style="padding-left: {i && i < lines.length ? 4 : 0}px">
        {#each line as [token, w], j (j)}
          <span class="h-[3px] rounded-sm" style="width: {w * 2.5}px; background: var(--{token})"></span>
        {/each}
      </span>
    {/each}
  </span>
</span>
