import assert from 'node:assert/strict'
import test from 'node:test'
import { installAlphaIceProxy } from './cloud-alpha-network.mjs'

// Protocol objects only: no socket, SFU, browser or acquisition is started.
test('ICE shim preserves accessor-backed SDP/candidate identity and only routes loopback TCP', async () => {
  const original = globalThis.RTCPeerConnection
  class Peer {
    async setRemoteDescription(value) {
      this.description = value
    }
    async addIceCandidate(value) {
      this.candidate = value
    }
  }
  globalThis.RTCPeerConnection = Peer
  try {
    installAlphaIceProxy({ targetPort: 7881, proxyPort: 8999 })
    const peer = new Peer()
    const tcp = 'candidate:1 1 tcp 100 127.0.0.1 7881 typ host tcptype passive'
    const udp = 'candidate:2 1 udp 100 127.0.0.1 7882 typ host'
    class Description {
      get type() {
        return 'offer'
      }
      get sdp() {
        return `v=0\r\na=ice-ufrag:unchanged\r\na=${tcp}\r\na=${udp}\r\n`
      }
    }
    await peer.setRemoteDescription(new Description())
    assert.equal(peer.description.type, 'offer')
    assert.match(peer.description.sdp, /ice-ufrag:unchanged/)
    assert.match(peer.description.sdp, /127.0.0.1 8999/)
    assert.equal(peer.description.sdp.includes(' udp '), false)
    class Candidate {
      get candidate() {
        return tcp
      }
      get sdpMid() {
        return 'video'
      }
      get sdpMLineIndex() {
        return 1
      }
      get usernameFragment() {
        return 'unchanged'
      }
    }
    await peer.addIceCandidate(new Candidate())
    assert.deepEqual(peer.candidate, {
      candidate: tcp.replace('7881', '8999'),
      sdpMid: 'video',
      sdpMLineIndex: 1,
      usernameFragment: 'unchanged'
    })
    const accepted = peer.candidate
    await peer.addIceCandidate({ candidate: udp })
    assert.equal(peer.candidate, accepted)
    assert.throws(
      () => peer.addIceCandidate({ candidate: tcp.replace('127.0.0.1', '192.0.2.1') }),
      /loopback/
    )
  } finally {
    if (original === undefined) delete globalThis.RTCPeerConnection
    else globalThis.RTCPeerConnection = original
  }
})
