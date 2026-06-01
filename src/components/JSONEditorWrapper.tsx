import { useEffect, useMemo, useRef } from 'react'
import { createJSONEditor, type Content, type JsonEditor, Mode } from 'vanilla-jsoneditor'
import 'vanilla-jsoneditor/themes/jse-theme-dark.css'

type Props = {
  value: string
  isValidJson: boolean
  onChange: (value: string) => void
  className?: string
}

export default function JSONEditorWrapper({ value, isValidJson, onChange, className = '' }: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const editorRef = useRef<JsonEditor | null>(null)

  const content = useMemo<Content>(() => {
    if (isValidJson) {
      try {
        return { json: JSON.parse(value) }
      } catch {
        return { text: value }
      }
    }

    return { text: value }
  }, [value, isValidJson])

  // Default to text mode to allow free-form editing; user can switch to tree view in the editor UI
  const mode = useMemo<Mode>(() => Mode.text, [])

  useEffect(() => {
    if (!containerRef.current) return

    editorRef.current = createJSONEditor({
      target: containerRef.current,
      props: {
        content,
        mode,
        // enable the built-in UI so users can add/delete/format items
        mainMenuBar: true,
        navigationBar: true,
        statusBar: true,
        askToFormat: true,
        indentation: 2,
        onChange: (updatedContent) => {
          const nextValue = 'json' in updatedContent ? JSON.stringify(updatedContent.json, null, 2) : updatedContent.text
          if (nextValue !== value) {
            onChange(nextValue)
          }
        },
      },
    })

    return () => {
      if (editorRef.current) {
        editorRef.current.destroy()
        editorRef.current = null
      }
    }
  }, [])

  useEffect(() => {
    if (editorRef.current) {
      editorRef.current.updateProps({ content, mode })
    }
  }, [content, mode])

  return <div ref={containerRef} className={`json-editor-wrapper jse-theme-dark ${className}`} />
}
