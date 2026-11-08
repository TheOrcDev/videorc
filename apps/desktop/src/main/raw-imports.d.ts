// Vite's `?raw` import: the file's text, bundled at build time. The main
// tsconfig types only node and electron, so the renderer's `vite/client`
// declaration does not reach it. Used to inline the live background scripts
// into the proof surface document (preview-surface-live-background.ts).
declare module '*?raw' {
  const text: string
  export default text
}
