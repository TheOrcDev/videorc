//! The store bridge (plan 260, "State: the core owns it, GPUI views reflect
//! it"): a GPUI entity mirrors one of the core's `tokio::sync::watch` stores.
//!
//! One task per store awaits `changed()` on GPUI's foreground executor
//! (Tokio's sync types run on any executor), maps the new value through a
//! pure view function and notifies the entity's observers only when the
//! mapped value changed. Views read the mapped value; they never hold the
//! core's state, and the core keeps running with every window closed.

use gpui::{App, AppContext, Entity};
use tokio::sync::watch;

/// The mapped value of one store, as views read it.
pub struct Mirror<V> {
    value: V,
}

impl<V> Mirror<V> {
    pub fn value(&self) -> &V {
        &self.value
    }
}

/// Mirrors `store` into a GPUI entity through `map`. The task ends when the
/// store's sender is gone or the entity is dropped.
pub fn mirror<T, V>(
    cx: &mut App,
    store: watch::Receiver<T>,
    map: impl Fn(&T) -> V + 'static,
) -> Entity<Mirror<V>>
where
    T: 'static,
    V: PartialEq + 'static,
{
    let initial = map(&*store.borrow());
    let entity = cx.new(|_| Mirror { value: initial });
    let weak = entity.downgrade();
    let mut store = store;
    cx.spawn(async move |cx| {
        while store.changed().await.is_ok() {
            let next = map(&*store.borrow_and_update());
            let alive = weak.update(cx, |mirror, cx| {
                if mirror.value != next {
                    mirror.value = next;
                    cx.notify();
                }
            });
            if alive.is_err() {
                break;
            }
        }
    })
    .detach();
    entity
}
