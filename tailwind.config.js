/** Every colour comes from a CSS variable defined in src/styles/themes.css. */
const v = (name) => `var(--${name})`
export default {
  content: ['./index.html', './src/**/*.{ts,svelte}'],
  theme: {
    extend: {
      colors: {
        bg: v('bg'),
        surface: v('surface'),
        raised: v('surface-raised'),
        hover: v('surface-hover'),
        border: v('border'),
        strong: v('border-strong'),
        fg: v('text'),
        muted: v('text-muted'),
        faint: v('text-faint'),
        accent: v('accent'),
        'accent-fg': v('accent-fg'),
        'accent-soft': v('accent-soft'),
        danger: v('danger'),
        'danger-soft': v('danger-soft'),
        success: v('success'),
        'success-soft': v('success-soft'),
        warning: v('warning'),
        'warning-soft': v('warning-soft'),
        overlay: v('overlay'),
      },
      fontFamily: {
        sans: v('font-sans'),
        mono: v('font-mono'),
      },
      boxShadow: { pop: v('shadow-pop') },
    },
  },
  plugins: [],
}
