import { useEffect, useRef, useState } from 'react'
import type { Orientation } from './useAppPreferences'

export function useResponseSplitter(orientation: Orientation) {
  const [responseHeight, setResponseHeight] = useState(260)
  const [isResizingResponse, setIsResizingResponse] = useState(false)
  const [responseWidth, setResponseWidth] = useState(420)
  const responseSplitRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    function handlePointerMove(event: PointerEvent) {
      if (!isResizingResponse || !responseSplitRef.current) return
      const rect = responseSplitRef.current.getBoundingClientRect()

      if (orientation === 'vertical') {
        const newHeight = rect.bottom - event.clientY
        const minHeight = 120
        const maxHeight = rect.height - 120

        setResponseHeight(Math.max(minHeight, Math.min(maxHeight, newHeight)))
      } else {
        const newWidth = rect.right - event.clientX
        const minWidth = 200
        const maxWidth = rect.width - 200

        setResponseWidth(Math.max(minWidth, Math.min(maxWidth, newWidth)))
      }
    }

    function handlePointerUp() {
      setIsResizingResponse(false)
    }

    if (isResizingResponse) {
      window.addEventListener('pointermove', handlePointerMove)
      window.addEventListener('pointerup', handlePointerUp)
      window.addEventListener('pointercancel', handlePointerUp)
    }

    return () => {
      window.removeEventListener('pointermove', handlePointerMove)
      window.removeEventListener('pointerup', handlePointerUp)
      window.removeEventListener('pointercancel', handlePointerUp)
    }
  }, [isResizingResponse, orientation])

  return {
    responseHeight,
    responseSplitRef,
    responseWidth,
    setIsResizingResponse,
  }
}
