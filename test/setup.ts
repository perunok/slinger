import '@testing-library/jest-dom/vitest'

// CodeMirror measures text with Range#getClientRects / getBoundingClientRect, which jsdom lacks.
const emptyRect = { x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, toJSON() {} }
if (typeof Range !== 'undefined') {
  Range.prototype.getBoundingClientRect = () => emptyRect as DOMRect
  Range.prototype.getClientRects = () =>
    ({ length: 0, item: () => null, [Symbol.iterator]: function* () {} }) as unknown as DOMRectList
}
if (typeof document !== 'undefined') {
  document.elementFromPoint = () => null
}
;(globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
}
;(globalThis as { matchMedia?: unknown }).matchMedia ??= (query: string) => ({
  matches: false,
  media: query,
  addEventListener() {},
  removeEventListener() {},
  addListener() {},
  removeListener() {},
  onchange: null,
  dispatchEvent: () => false,
})
