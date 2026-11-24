//! The display sleep guard's D-Bus calls (plan 260 S2.6c): the core's
//! `InhibitBus` (`desktop::linux::sleep_inhibit`, which picks the route and
//! keeps the holds) over the Inhibit portal and `org.freedesktop.ScreenSaver`.

use std::collections::HashMap;
use std::sync::Arc;

use ashpd::zbus;
use ashpd::zvariant::{OwnedObjectPath, Value};
use videorc_app_core::desktop::linux::sleep_inhibit::{InhibitBus, InhibitError};

use super::bus::{Bus, CALL_DEADLINE};

const PORTAL: &str = "org.freedesktop.portal.Desktop";
const PORTAL_PATH: &str = "/org/freedesktop/portal/desktop";
const SCREENSAVER: &str = "org.freedesktop.ScreenSaver";
const SCREENSAVER_PATH: &str = "/org/freedesktop/ScreenSaver";

/// A bus error that means "nobody here implements this", not a failure.
fn missing(error: &str) -> bool {
    [
        "ServiceUnknown",
        "UnknownMethod",
        "UnknownInterface",
        "UnknownObject",
        "NotSupported",
        "no session bus",
    ]
    .iter()
    .any(|name| error.contains(name))
}

fn classify(error: String) -> InhibitError {
    if missing(&error) {
        InhibitError::NotAvailable
    } else {
        InhibitError::Failed(error)
    }
}

pub struct DbusInhibit {
    bus: Arc<Bus>,
}

impl DbusInhibit {
    pub fn new(bus: Arc<Bus>) -> Self {
        Self { bus }
    }
}

impl InhibitBus for DbusInhibit {
    fn portal_inhibit(&mut self, flags: u32, reason: &str) -> Result<String, InhibitError> {
        let connection = self.bus.connection();
        let reason = reason.to_string();
        self.bus
            .call(CALL_DEADLINE, async move {
                let connection = connection.await?;
                let mut options: HashMap<&str, Value<'_>> = HashMap::new();
                options.insert("reason", Value::from(reason.as_str()));
                let reply = connection
                    .call_method(
                        Some(PORTAL),
                        PORTAL_PATH,
                        Some("org.freedesktop.portal.Inhibit"),
                        "Inhibit",
                        &("", flags, options),
                    )
                    .await
                    .map_err(|error| error.to_string())?;
                let handle: OwnedObjectPath = reply
                    .body()
                    .deserialize()
                    .map_err(|error: zbus::Error| error.to_string())?;
                Ok(handle.as_str().to_string())
            })
            .map_err(classify)
    }

    fn portal_release(&mut self, handle: &str) -> Result<(), InhibitError> {
        let connection = self.bus.connection();
        let handle = handle.to_string();
        self.bus
            .call(CALL_DEADLINE, async move {
                let connection = connection.await?;
                connection
                    .call_method(
                        Some(PORTAL),
                        handle.as_str(),
                        Some("org.freedesktop.portal.Request"),
                        "Close",
                        &(),
                    )
                    .await
                    .map(|_| ())
                    .map_err(|error| error.to_string())
            })
            .map_err(classify)
    }

    fn screensaver_inhibit(&mut self, app: &str, reason: &str) -> Result<u32, InhibitError> {
        let connection = self.bus.connection();
        let (app, reason) = (app.to_string(), reason.to_string());
        self.bus
            .call(CALL_DEADLINE, async move {
                let connection = connection.await?;
                let reply = connection
                    .call_method(
                        Some(SCREENSAVER),
                        SCREENSAVER_PATH,
                        Some(SCREENSAVER),
                        "Inhibit",
                        &(app.as_str(), reason.as_str()),
                    )
                    .await
                    .map_err(|error| error.to_string())?;
                reply
                    .body()
                    .deserialize::<u32>()
                    .map_err(|error| error.to_string())
            })
            .map_err(classify)
    }

    fn screensaver_release(&mut self, cookie: u32) -> Result<(), InhibitError> {
        let connection = self.bus.connection();
        self.bus
            .call(CALL_DEADLINE, async move {
                let connection = connection.await?;
                connection
                    .call_method(
                        Some(SCREENSAVER),
                        SCREENSAVER_PATH,
                        Some(SCREENSAVER),
                        "UnInhibit",
                        &(cookie,),
                    )
                    .await
                    .map(|_| ())
                    .map_err(|error| error.to_string())
            })
            .map_err(classify)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_missing_service_is_not_a_failure() {
        assert_eq!(
            classify("org.freedesktop.DBus.Error.ServiceUnknown: no such name".into()),
            InhibitError::NotAvailable
        );
        assert_eq!(
            classify("no session bus: connection refused".into()),
            InhibitError::NotAvailable
        );
        assert_eq!(
            classify("org.freedesktop.portal.Error.Failed: denied".into()),
            InhibitError::Failed("org.freedesktop.portal.Error.Failed: denied".into())
        );
    }
}
