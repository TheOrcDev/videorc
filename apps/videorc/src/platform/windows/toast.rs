//! System notifications as WinRT toasts, what Electron's `Notification`
//! shows on Windows: a title and a body under the app id, silent when
//! asked, and a click handed back while the app runs (the stream watchdog's
//! card, plan 223 A7). A click after the app quit opens nothing: that needs
//! a COM activator the installer registers, which no Windows path of the
//! Electron app has either.

use windows::Data::Xml::Dom::XmlDocument;
use windows::Foundation::TypedEventHandler;
use windows::UI::Notifications::{ToastNotification, ToastNotificationManager};
use windows::Win32::System::WinRT::{RO_INIT_MULTITHREADED, RoInitialize};
use windows::core::HSTRING;

use crate::platform::{Notice, OsResult};

/// `text` safe inside an XML element or attribute.
pub(super) fn escape(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for character in text.chars() {
        match character {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&apos;"),
            other => out.push(other),
        }
    }
    out
}

/// The toast's content: the generic template's two lines.
pub(super) fn toast_xml(title: &str, body: &str, silent: bool) -> String {
    let audio = if silent {
        r#"<audio silent="true"/>"#
    } else {
        ""
    };
    format!(
        r#"<toast><visual><binding template="ToastGeneric"><text>{}</text><text>{}</text></binding></visual>{audio}</toast>"#,
        escape(title),
        escape(body)
    )
}

pub(super) fn show(app_id: &str, notice: Notice) -> OsResult<()> {
    // WinRT needs the calling thread in an apartment. A core worker joins
    // the multithreaded one; GPUI's main thread is already in one, which
    // answers "changed mode", and that is fine.
    // SAFETY: no pointers; an apartment stays joined for the thread's life.
    let _ = unsafe { RoInitialize(RO_INIT_MULTITHREADED) };
    let shown = || -> windows::core::Result<()> {
        let content = XmlDocument::new()?;
        content.LoadXml(&HSTRING::from(toast_xml(
            &notice.title,
            &notice.body,
            notice.silent,
        )))?;
        let toast = ToastNotification::CreateToastNotification(&content)?;
        if let Some(on_click) = notice.on_click {
            toast.Activated(&TypedEventHandler::new(move |_, _| {
                on_click();
                Ok(())
            }))?;
        }
        ToastNotificationManager::CreateToastNotifierWithId(&HSTRING::from(app_id))?.Show(&toast)
    };
    shown().map_err(|error| format!("the toast didn't show: {error}"))
}

#[cfg(test)]
mod tests {
    use super::{escape, toast_xml};

    #[test]
    fn markup_in_a_chat_name_stays_text() {
        assert_eq!(
            escape(r#"<b>"Tom" & 'Jerry'</b>"#),
            "&lt;b&gt;&quot;Tom&quot; &amp; &apos;Jerry&apos;&lt;/b&gt;"
        );
    }

    #[test]
    fn a_silent_toast_carries_the_silent_audio_element() {
        let xml = toast_xml("Stream", "Dropped frames", true);
        assert!(xml.contains("<text>Stream</text><text>Dropped frames</text>"));
        assert!(xml.ends_with(r#"<audio silent="true"/></toast>"#));
        assert!(!toast_xml("a", "b", false).contains("<audio"));
    }
}
