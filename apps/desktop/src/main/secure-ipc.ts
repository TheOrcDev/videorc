import { ipcMain, type WebContents } from 'electron'

import {
  validateElectronEventPayload,
  validateElectronInvokeArgs,
  validateElectronInvokeResult,
  type ElectronEventChannel,
  type ElectronIpcEventMap
} from '../shared/electron-ipc-contract'
import {
  IPC_INVOKE_ROLES,
  RendererSecurityRegistry,
  type SecureIpcChannel
} from '../shared/renderer-security-policy'

export const rendererSecurityRegistry = new RendererSecurityRegistry()

type SecureIpcListener = Parameters<typeof ipcMain.handle>[1]

/**
 * The only supported registration path for renderer-invoked IPC. Both the
 * BrowserWindow-owned role and the invoking frame's exact trusted document are
 * checked before application code receives any arguments.
 */
export function secureIpcHandle(channel: SecureIpcChannel, listener: SecureIpcListener): void {
  if (!(channel in IPC_INVOKE_ROLES)) {
    throw new Error(`IPC channel ${channel} has no renderer security policy.`)
  }
  ipcMain.handle(channel, async (event, ...args) => {
    const senderFrame = event.senderFrame
    const mainFrame = event.sender.mainFrame
    const identity = {
      senderId: event.sender.id,
      frameUrl: senderFrame?.url ?? '',
      isMainFrame:
        senderFrame?.processId === mainFrame.processId &&
        senderFrame.routingId === mainFrame.routingId
    }
    if (!rendererSecurityRegistry.invokeAllowed(channel, identity)) {
      throw new Error('Renderer is not authorized to invoke this operation.')
    }
    const validatedArgs = validateElectronInvokeArgs(channel, args)
    const result = await listener(event, ...validatedArgs)
    return validateElectronInvokeResult(channel, result)
  })
}

export function sendElectronEvent<TChannel extends ElectronEventChannel>(
  contents: WebContents,
  channel: TChannel,
  payload: ElectronIpcEventMap[TChannel]
): void {
  contents.send(channel, validateElectronEventPayload(channel, payload))
}
