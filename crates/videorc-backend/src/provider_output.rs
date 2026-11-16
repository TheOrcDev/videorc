//! Provider activation is owned by an output interval, not a fabricated encoder.
//! Pure admission used by scheduled provider operations; no credentials here.
#[derive(Clone, Copy)]
pub struct CloudProviderOutput<'a> {
    pub show_id: &'a str,
    pub interval: &'a str,
    pub connected: bool,
    pub live: bool,
    pub ending: bool,
    pub elsewhere: bool,
}

impl CloudProviderOutput<'_> {
    pub fn owner_token(&self, session: &str, owns_destination: bool) -> Option<String> {
        (self.show_id == session
            && !self.interval.is_empty()
            && self.connected
            && self.live
            && !self.ending
            && !self.elsewhere
            && owns_destination)
            .then(|| format!("{}:{}", self.show_id, self.interval))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn cloud_owner_requires_current_connected_interval_and_exact_destination() {
        let mut output = CloudProviderOutput {
            show_id: "show",
            interval: "interval-a",
            connected: true,
            live: true,
            ending: false,
            elsewhere: false,
        };
        assert_eq!(
            output.owner_token("show", true).as_deref(),
            Some("show:interval-a")
        );
        assert!(output.owner_token("old-show", true).is_none());
        assert!(output.owner_token("show", false).is_none());
        output.connected = false;
        assert!(output.owner_token("show", true).is_none());
        output.connected = true;
        output.elsewhere = true;
        assert!(output.owner_token("show", true).is_none());
        output.elsewhere = false;
        output.ending = true;
        assert!(output.owner_token("show", true).is_none());
    }
    #[test]
    fn successive_live_intervals_do_not_share_activation_authority() {
        let mut output = CloudProviderOutput {
            show_id: "show",
            interval: "interval-a",
            connected: true,
            live: true,
            ending: false,
            elsewhere: false,
        };
        let first = output.owner_token("show", true);
        output.interval = "interval-b";
        assert_ne!(first, output.owner_token("show", true));
        output.live = false;
        assert!(output.owner_token("show", true).is_none());
    }
}
