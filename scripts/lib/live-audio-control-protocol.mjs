export function successfulLiveCommandReplies(output) {
  return output.match(/\bret:0\s+res:/g) ?? []
}

/** Progress and filter acknowledgements use different OS pipes. Never combine chunks. */
export function liveAudioProtocolStreams({ reply, progress }) {
  const buffers = { stdout: '', stderr: '' }
  const emit = (channel, line) => {
    if (channel === 'stdout') {
      if (line.trim() === 'progress=continue') progress()
    } else {
      for (const acknowledgement of successfulLiveCommandReplies(line)) reply(acknowledgement)
    }
  }
  return {
    push(channel, chunk) {
      if (!(channel in buffers)) throw new Error('Unknown live audio protocol pipe.')
      buffers[channel] += chunk
      const lines = buffers[channel].split(/[\r\n]/)
      buffers[channel] = lines.pop() ?? ''
      for (const line of lines) emit(channel, line)
    },
    finish() {
      for (const channel of ['stdout', 'stderr']) {
        if (buffers[channel]) emit(channel, buffers[channel])
        buffers[channel] = ''
      }
    }
  }
}
