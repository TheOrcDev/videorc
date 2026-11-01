/** Ephemeral local metadata. Never include it in logs or support bundles. */
export interface FrontApp {
  bundleId?: string | null
  name: string
  pid: number
}
export interface FrontAppChanged extends FrontApp {
  frontWindowId?: string
  at: number
}
export interface FrontAppApi {
  onFrontAppChanged(callback: (event: FrontAppChanged) => void): () => void
  setFrontWindowWatch(enabled: boolean): Promise<void>
  getSelfBundleIds(): Promise<string[]>
}
// Keep this slice independent of the backend/RPC-owned declaration file.
declare module './backend' {
  // Module augmentation adds the separately owned foreground API.
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type
  interface VideorcApi extends FrontAppApi {}
}
