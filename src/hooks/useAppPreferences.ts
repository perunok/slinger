import { useEffect, useState } from 'react'

export type Theme = 'dark' | 'light'
export type Orientation = 'vertical' | 'horizontal'

export function useAppPreferences() {
  const [orientation, setOrientation] = useState<Orientation>(() => {
    const saved = window.localStorage.getItem('slinger-orientation')
    return saved === 'horizontal' ? 'horizontal' : 'vertical'
  })
  const [theme, setTheme] = useState<Theme>(() => {
    const saved = window.localStorage.getItem('slinger-theme')
    return saved === 'light' ? 'light' : 'dark'
  })

  useEffect(() => {
    window.localStorage.setItem('slinger-orientation', orientation)
  }, [orientation])

  useEffect(() => {
    document.documentElement.dataset.theme = theme
    window.localStorage.setItem('slinger-theme', theme)
  }, [theme])

  return {
    orientation,
    setOrientation,
    theme,
    setTheme,
  }
}
