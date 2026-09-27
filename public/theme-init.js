// Applies the persisted theme and accent before first paint (external file: the app CSP forbids inline scripts).
// Mirrors src/lib/appearance.ts (key `slinger.appearance`; `slinger.theme` is the format up to 0.2.0). A custom theme
// (`custom:<uuid>`, key `slinger.customThemes`) is shown as its base theme plus a rule rebuilt from the stored,
// already validated token map exactly like customThemeRule() in src/lib/customThemes.ts (a test compares the two).
// settings.init() validates and re-applies everything right after startup.
try {
  var d = document.documentElement
  var a = {}
  try {
    a = JSON.parse(localStorage.getItem('slinger.appearance') || '{}') || {}
  } catch (e) {}
  var t = a.theme || localStorage.getItem('slinger.theme') || 'system'
  if (t === 'system') {
    t = matchMedia('(prefers-color-scheme: light)').matches ? a.systemLight || 'light' : a.systemDark || 'dark'
  }
  if (t.indexOf('custom:') === 0) {
    var c = null
    try {
      var s = JSON.parse(localStorage.getItem('slinger.customThemes') || '{}')
      if (s && s.v === 1 && Array.isArray(s.themes)) c = s.themes.filter(function (x) { return x && x.id === t })[0]
    } catch (e) {}
    t = 'dark'
    if (c && /^custom:[a-z0-9-]{1,64}$/.test(c.id) && /^[a-z0-9-]{1,64}$/.test(c.base)) {
      var sel = "[data-theme][data-custom-theme='" + c.id + "']"
      var main = 'color-scheme:' + (c.scheme === 'light' ? 'light' : 'dark') + ';'
      var acc = ''
      var tk = c.tokens || {}
      for (var k in tk) {
        var v = tk[k]
        if (!/^[a-z0-9-]{1,40}$/.test(k) || typeof v !== 'string' || v.length > 160 || !/^[a-zA-Z0-9#(),.%\s\/+-]+$/.test(v)) continue
        var fns = v.match(/([a-zA-Z_-][\w-]*)?\s*\(/g) || []
        if (!fns.every(function (f) { return /^(rgba?|hsla?|hwb|lab|lch|oklab|oklch|color|color-mix|light-dark)\s*\($/i.test(f) })) continue
        if (/^(accent|accent-fg|accent-soft|accent-text|focus-ring|selection)$/.test(k)) acc += '--' + k + ':' + v + ';'
        else main += '--' + k + ':' + v + ';'
      }
      var st = document.createElement('style')
      st.id = 'slinger-custom-themes'
      st.textContent = sel + '{' + main + '}' + (acc ? '\n' + sel + ':not([data-accent]){' + acc + '}' : '')
      document.head.appendChild(st)
      d.setAttribute('data-custom-theme', c.id)
      t = c.base
    }
  }
  d.setAttribute('data-theme', t)
  if (a.accent && a.accent !== 'theme') d.setAttribute('data-accent', a.accent)
} catch (e) {}
