/// Counts the apps holding the source stream. CMIO calls `startStream` once per
/// client and `stopStream` when each lets go, so the count is the number of
/// viewers (D13: the compositor composes pixels only while this is non-zero).
public struct ClientCounter: Equatable {
    public private(set) var count = 0

    public init() {}

    public var isStreaming: Bool { count > 0 }

    @discardableResult
    public mutating func clientStarted() -> Int {
        count += 1
        return count
    }

    /// Never goes below zero: an unbalanced stop is a CMIO quirk, not a reason
    /// to report a negative viewer count.
    @discardableResult
    public mutating func clientStopped() -> Int {
        count = max(0, count - 1)
        return count
    }
}
