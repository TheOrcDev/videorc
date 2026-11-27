//! Await the owning feed's drain acknowledgement outside GPUI's foreground.
use serde_json::Value;
use tokio::sync::oneshot;

pub(super) async fn wait_for_drain(
    answer: oneshot::Receiver<Result<Vec<Value>, String>>,
) -> Result<usize, String> {
    tokio::time::timeout(std::time::Duration::from_secs(5), answer)
        .await
        .map_err(|_| "The native preview host drain timed out.".to_string())?
        .map_err(|_| "The native preview feed closed before acknowledging the drain.".to_string())?
        .map(|commands| commands.len())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn answers_only_after_the_feed_finishes_and_keeps_failures() {
        let (send, receive) = oneshot::channel();
        let task = tokio::spawn(wait_for_drain(receive));
        tokio::task::yield_now().await;
        assert!(!task.is_finished(), "enqueueing is not a completed drain");
        send.send(Ok(vec![serde_json::json!({"kind": "destroy"})]))
            .unwrap();
        assert_eq!(task.await.unwrap(), Ok(1));
        let (send, receive) = oneshot::channel();
        send.send(Err("backend disconnected".into())).unwrap();
        assert_eq!(
            wait_for_drain(receive).await,
            Err("backend disconnected".into())
        );
        let (send, receive) = oneshot::channel();
        drop(send);
        assert!(
            wait_for_drain(receive)
                .await
                .unwrap_err()
                .contains("closed")
        );
    }
}
