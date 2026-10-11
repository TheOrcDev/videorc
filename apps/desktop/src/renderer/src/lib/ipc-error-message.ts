// Electron re-throws a rejected `ipcMain.handle` in the renderer as
// "Error invoking remote method '<channel>': Error: <message>". The channel and
// class name are transport noise; only the handler's own message belongs in
// front of a user (plan 073: the live account-refresh toast showed both).
const ELECTRON_IPC_ERROR_PREFIX = /^Error invoking remote method '[^']+': (?:[A-Za-z]*Error: )?/

/** `message` without Electron's remote-method wrapper (plan 174 S2.4). */
export function stripIpcPrefix(message: string): string {
  return message.replace(ELECTRON_IPC_ERROR_PREFIX, '')
}

export function ipcErrorMessage(error: unknown): string {
  return stripIpcPrefix(error instanceof Error ? error.message : String(error))
}
