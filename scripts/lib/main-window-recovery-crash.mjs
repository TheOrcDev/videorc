// A sent Page.crash command is not proof that Chromium executed it. Subscribe
// before sending, retain protocol refusals, and keep the session open until an
// actual renderer-crash event or the bounded deadline. No sleep is a handshake.
export function observeRendererCrash(url, { Socket = WebSocket, timeoutMs = 10000 } = {}) {
  return new Promise((resolve) => {
    const evidence = {
      crashRequested: false,
      crashed: false,
      crashEvent: null,
      protocolErrors: [],
      error: null
    }
    let socket
    let timer
    let finished = false
    const finish = (error = null) => {
      if (finished) return
      finished = true
      clearTimeout(timer)
      evidence.error = error
      if (socket) {
        socket.removeEventListener('open', opened)
        socket.removeEventListener('message', received)
        socket.removeEventListener('error', failed)
        socket.removeEventListener('close', closed)
        socket.close()
      }
      resolve(evidence)
    }
    const send = (id, method) => {
      try {
        socket.send(JSON.stringify({ id, method }))
      } catch (error) {
        finish(`CDP ${method} send failed: ${error.message}`)
      }
    }
    const opened = () => send(1, 'Inspector.enable')
    const received = (event) => {
      let message
      try {
        message = JSON.parse(event.data)
        if (message === null || typeof message !== 'object') throw new Error('Not a CDP message')
      } catch {
        finish('CDP returned invalid JSON.')
        return
      }
      if (message.error) {
        evidence.protocolErrors.push({
          method: message.id === 1 ? 'Inspector.enable' : message.id === 2 ? 'Page.crash' : null,
          code: message.error.code,
          message: message.error.message
        })
      }
      if (message.id === 1) {
        if (message.error) {
          finish('Could not enable renderer-crash observations.')
        } else if (!evidence.crashRequested) {
          evidence.crashRequested = true
          send(2, 'Page.crash')
        }
      } else if (message.method === 'Inspector.targetCrashed' && evidence.crashRequested) {
        evidence.crashed = true
        evidence.crashEvent = message.method
        finish()
      }
      // Page.crash may itself fail with "Target crashed" before the event
      // arrives. Retain that response, but only the event can prove the crash.
    }
    const failed = () => finish('CDP socket error before a renderer-crash event.')
    const closed = () => finish('CDP socket closed before a renderer-crash event.')
    timer = setTimeout(() => finish('No renderer-crash event before the deadline.'), timeoutMs)
    try {
      socket = new Socket(url)
      socket.addEventListener('open', opened)
      socket.addEventListener('message', received)
      socket.addEventListener('error', failed)
      socket.addEventListener('close', closed)
    } catch (error) {
      finish(`CDP connection failed: ${error.message}`)
    }
  })
}
