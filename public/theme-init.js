// Applies the persisted theme before first paint (external file: the app CSP forbids inline scripts).
try {
  var t = localStorage.getItem('slinger.theme') || 'system'
  if (t === 'system') t = matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'
  document.documentElement.setAttribute('data-theme', t)
} catch (e) {}
