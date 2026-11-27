//! Stream Manager image evidence from the real element paint traversal.
//! Downloaded bytes and layout alone never count as a painted image.

use std::cell::RefCell;
use std::collections::BTreeMap;
use std::rc::Rc;

use gpui::{
    AnyElement, App, Bounds, Element, ElementId, GlobalElementId, InspectorElementId, IntoElement,
    LayoutId, Pixels, Window, px,
};
use serde_json::{Value, json};

use crate::screens::chat_media::Picture;

type Images = BTreeMap<(String, &'static str, String), Value>;

#[derive(Clone, Default)]
pub(super) struct PaintedImages {
    images: Rc<RefCell<Images>>,
    enabled: bool,
}

impl PaintedImages {
    pub fn for_smoke() -> Self {
        Self {
            enabled: videorc_app_core::smoke::SmokeSwitch::resolve(
                |name| std::env::var(name).ok(),
                crate::smoke::shell::packaged(),
            )
            .is_some(),
            ..Self::default()
        }
    }

    pub fn begin_frame(&self) {
        self.images.borrow_mut().clear();
    }

    pub fn row(&self, id: &str) -> Value {
        let images: Vec<_> = self
            .images
            .borrow()
            .iter()
            .filter(|((row, _, _), _)| row == id)
            .map(|(_, image)| image.clone())
            .collect();
        json!({ "id": id, "images": images, "gifMode": null, "gifStills": [] })
    }

    pub fn observe(
        &self,
        row: &str,
        slot: &'static str,
        picture: Option<&Picture>,
        child: AnyElement,
    ) -> AnyElement {
        if !self.enabled {
            return child;
        }
        let Some(Picture::Decoded { image, route }) = picture else {
            return child;
        };
        let size = image.size(0);
        PaintObserved {
            child,
            proof: self.clone(),
            row: row.into(),
            slot,
            route: route.clone(),
            decoded: image.frame_count() > 0 && size.width.0 > 0 && size.height.0 > 0,
        }
        .into_any_element()
    }

    fn note_paint(&self, row: &str, slot: &'static str, route: &str, decoded: bool, visible: bool) {
        // The exact local route was retained with the bytes GPUI decoded.
        if !self.enabled
            || !decoded
            || !visible
            || videorc_app_core::chat::images::route_target(route).is_none()
        {
            return;
        }
        self.images.borrow_mut().insert(
            (row.into(), slot, route.into()),
            json!({ "slot": slot, "src": route, "loaded": decoded }),
        );
    }
}

struct PaintObserved {
    child: AnyElement,
    proof: PaintedImages,
    row: String,
    slot: &'static str,
    route: String,
    decoded: bool,
}

impl Element for PaintObserved {
    type RequestLayoutState = ();
    type PrepaintState = ();
    fn id(&self) -> Option<ElementId> {
        None
    }
    fn source_location(&self) -> Option<&'static std::panic::Location<'static>> {
        None
    }
    fn request_layout(
        &mut self,
        _: Option<&GlobalElementId>,
        _: Option<&InspectorElementId>,
        window: &mut Window,
        cx: &mut App,
    ) -> (LayoutId, ()) {
        (self.child.request_layout(window, cx), ())
    }
    fn prepaint(
        &mut self,
        _: Option<&GlobalElementId>,
        _: Option<&InspectorElementId>,
        _: Bounds<Pixels>,
        _: &mut (),
        window: &mut Window,
        cx: &mut App,
    ) {
        self.child.prepaint(window, cx);
    }
    fn paint(
        &mut self,
        _: Option<&GlobalElementId>,
        _: Option<&InspectorElementId>,
        bounds: Bounds<Pixels>,
        _: &mut (),
        _: &mut (),
        window: &mut Window,
        cx: &mut App,
    ) {
        self.child.paint(window, cx);
        let clipped = bounds.intersect(&window.content_mask().bounds);
        self.proof.note_paint(
            &self.row,
            self.slot,
            &self.route,
            self.decoded,
            clipped.size.width > px(0.) && clipped.size.height > px(0.),
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_visible_decoded_paints_from_this_frame_count() {
        let proof = PaintedImages {
            enabled: true,
            ..PaintedImages::default()
        };
        let route = "http://127.0.0.1:1234/chat-images/avatar.png?key=fixture";
        assert_eq!(proof.row("row")["images"], json!([]));
        proof.note_paint("row", "avatar-image", route, false, true);
        proof.note_paint("row", "avatar-image", route, true, false);
        proof.note_paint(
            "row",
            "avatar-image",
            "https://cdn.example/avatar.png",
            true,
            true,
        );
        assert_eq!(proof.row("row")["images"], json!([]));
        proof.note_paint("row", "avatar-image", route, true, true);
        assert_eq!(
            proof.row("row")["images"][0],
            json!({"slot":"avatar-image", "src":route, "loaded":true})
        );
        assert_eq!(proof.row("other")["images"], json!([]));
        proof.begin_frame();
        assert_eq!(proof.row("row")["images"], json!([]));
    }
}
