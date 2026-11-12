// A tap or a hold on one key (plan 230): a tap acts on release, a hold acts
// once the key has been down for HOLD_MS, while it is still down.
export const HOLD_MS = 500;
export function createHoldGesture({ onTap, onHold }) {
    const pending = new Map();
    return {
        down(key) {
            if (pending.has(key))
                return;
            pending.set(key, setTimeout(() => {
                pending.delete(key);
                onHold(key);
            }, HOLD_MS));
        },
        up(key) {
            const timer = pending.get(key);
            if (!timer)
                return;
            clearTimeout(timer);
            pending.delete(key);
            onTap(key);
        },
        cancel(key) {
            clearTimeout(pending.get(key));
            pending.delete(key);
        }
    };
}
