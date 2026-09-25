// Applies the persisted theme and accent before first paint (external file: the app CSP forbids inline scripts).
// Mirrors src/lib/appearance.ts (key `slinger.appearance`; `slinger.theme` is the format up to 0.2.0).
// settings.init() validates and re-applies everything right after startup.
try {
  var a = {}
  try {
    a = JSON.parse(localStorage.getItem('slinger.appearance') || '{}') || {}
  } catch (e) {}
  var t = a.theme || localStorage.getItem('slinger.theme') || 'system'
  if (t === 'system') {
    t = matchMedia('(prefers-color-scheme: light)').matches ? a.systemLight || 'light' : a.systemDark || 'dark'
  }
  document.documentElement.setAttribute('data-theme', t)
  if (a.accent && a.accent !== 'theme') document.documentElement.setAttribute('data-accent', a.accent)
} catch (e) {}
