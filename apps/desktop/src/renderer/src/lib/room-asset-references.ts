/**
 * PERF-06: lease renewals and content changes without resending the same pixels.
 *
 * A program page that advertises `refs: 1` resolves an asset sent as
 * `{ hash, width, height }` (no `png`) from the snapshot it last committed.
 * The publishers send that form only for a hash the page provably holds:
 *
 * - the page's current receipt acknowledges, as applied by this publisher,
 *   a revision we sent to this very peer session (and its lease still runs);
 * - the hash is in that snapshot AND in every snapshot written to the session
 *   after it, so whichever of them the page committed last, it holds the hash.
 *
 * Anything else (an older page, a new session, no or a foreign
 * acknowledgement, a new picture) goes whole, exactly as before. A reference
 * the page still cannot resolve (it cleared) is refused there; its
 * acknowledgement then stays behind and the next renewal goes whole, 10 s
 * later, well inside the 30 s lease.
 */
type Asset = { hash: string; png: string; width: number; height: number }
type Sent = { revision: number; expiresAt: number; hashes: ReadonlySet<string> }

/** Bounded per peer: a receipt acknowledging anything older just gets whole assets. */
const HISTORY = 8

export class SentAssets {
  #peers = new Map<string, { sid: string; publisherSid: string; sent: Sent[] }>()

  /** A snapshot fully written to `identity`'s session `sid` (its page may commit it). */
  record(
    identity: string,
    sid: string,
    publisherSid: string,
    snapshot: { revision: number; expiresAt: number; layers: { asset: { hash: string } }[] }
  ): void {
    let peer = this.#peers.get(identity)
    if (!peer || peer.sid !== sid || peer.publisherSid !== publisherSid) {
      peer = { sid, publisherSid, sent: [] }
      this.#peers.set(identity, peer)
    }
    peer.sent.push({
      revision: snapshot.revision,
      expiresAt: snapshot.expiresAt,
      hashes: new Set(snapshot.layers.map((l) => l.asset.hash))
    })
    if (peer.sent.length > HISTORY) peer.sent.shift()
  }

  /** The hashes `identity` provably holds now, given its receipt; empty when unsure. */
  held(
    identity: string,
    receipt: {
      refs: boolean
      applied: { publisherSid: string; revision: number } | undefined
      sid: string
    },
    localSid: string,
    now = Date.now()
  ): ReadonlySet<string> {
    const peer = this.#peers.get(identity)
    const { refs, applied, sid } = receipt
    if (
      !refs ||
      !applied ||
      !peer ||
      peer.sid !== sid ||
      peer.publisherSid !== localSid ||
      applied.publisherSid !== localSid
    )
      return new Set()
    const from = peer.sent.findIndex((s) => s.revision === applied.revision)
    if (from < 0 || peer.sent[from]!.expiresAt <= now) return new Set()
    const held = new Set(peer.sent[from]!.hashes)
    for (const later of peer.sent.slice(from + 1))
      for (const hash of held) if (!later.hashes.has(hash)) held.delete(hash)
    return held
  }

  forget(identity: string): void {
    this.#peers.delete(identity)
  }

  clear(): void {
    this.#peers.clear()
  }
}

/**
 * The wire form (only ever serialized): each held asset loses its `png`; the
 * snapshot is otherwise the same. Nothing held: the snapshot itself.
 */
export function withReferences<L extends { asset: Asset }>(
  snapshot: { layers: L[] },
  held: ReadonlySet<string>
): unknown {
  if (!held.size) return snapshot
  return {
    ...snapshot,
    layers: snapshot.layers.map((layer) =>
      held.has(layer.asset.hash)
        ? {
            ...layer,
            asset: { hash: layer.asset.hash, width: layer.asset.width, height: layer.asset.height }
          }
        : layer
    )
  }
}
