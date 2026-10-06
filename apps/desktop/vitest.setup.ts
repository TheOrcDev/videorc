// Node has no DOM. Radix form controls evaluate `instanceof HTMLFormElement`
// while mounting, which throws unless the constructor exists.
if (typeof globalThis.HTMLFormElement === 'undefined') {
  globalThis.HTMLFormElement = class HTMLFormElement {}
}
