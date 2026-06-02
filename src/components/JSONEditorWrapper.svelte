<script lang="ts">
  import { onDestroy, onMount } from 'svelte'
  import { createJSONEditor, type Content, type JsonEditor, Mode } from 'vanilla-jsoneditor'
  import 'vanilla-jsoneditor/themes/jse-theme-dark.css'

  export let value: string
  export let isValidJson: boolean
  export let onChange: (value: string) => void
  export let className = ''

  let containerRef: HTMLDivElement
  let editorRef: JsonEditor | null = null
  let editorValue = ''
  const mode = Mode.text

  function contentFromValue(nextValue: string): Content {
    if (isValidJson) {
      try {
        return { json: JSON.parse(nextValue) }
      } catch {
        return { text: nextValue }
      }
    }

    return { text: nextValue }
  }

  onMount(() => {
    editorValue = value
    editorRef = createJSONEditor({
      target: containerRef,
      props: {
        content: contentFromValue(editorValue),
        mode,
        mainMenuBar: true,
        navigationBar: true,
        statusBar: true,
        askToFormat: true,
        indentation: 2,
        onChange: (updatedContent) => {
          const nextValue = 'json' in updatedContent
            ? JSON.stringify(updatedContent.json, null, 2)
            : updatedContent.text
          if (nextValue !== editorValue) {
            editorValue = nextValue
            onChange(nextValue)
          }
        },
      },
    })
  })

  onDestroy(() => {
    editorRef?.destroy()
    editorRef = null
  })

  $: if (editorRef && value !== editorValue) {
    editorValue = value
    editorRef.updateProps({ content: contentFromValue(editorValue), mode })
  }
</script>

<div bind:this={containerRef} class={`json-editor-wrapper jse-theme-dark ${className}`} />
