//! Retry one model call the way `packages/agent-core/src/loop/retry.ts` does.
//!
//! A context-overflow error is returned on the first attempt. Retrying the
//! same payload cannot make it fit; the turn loop has to compact and then
//! call again. Other retryable failures (429, 500, 502, 503, 504, transport)
//! are tried again up to `max_attempts`.

use std::future::Future;

use lmcode_llm::LlmError;

/// Default attempts, including the first call. Matches `DEFAULT_MAX_RETRY_ATTEMPTS`.
pub const DEFAULT_MAX_RETRY_ATTEMPTS: u32 = 3;

const RETRY_MIN_TIMEOUT_MS: u64 = 300;
const RETRY_MAX_TIMEOUT_MS: u64 = 5_000;
const RETRY_FACTOR: u64 = 2;

/// Ceiling for a rate-limit wait. Matches `RATE_LIMIT_MAX_TIMEOUT_MS`.
pub const RATE_LIMIT_MAX_TIMEOUT_MS: u64 = 60_000;

/// Call `call` until it succeeds, the error must surface, or attempts run out.
///
/// `classify` is false when the provider has no `isRetryableError` hook: the
/// function makes one call and returns whatever that call returned.
/// `is_retryable` is consulted only after the overflow check, so a callback
/// that treats every error as retryable still cannot retry an overflow.
pub async fn chat_with_retry<T, F, Fut, R, S, SleepFut>(
    max_attempts: u32,
    classify: bool,
    is_retryable: R,
    mut call: F,
    mut sleep: S,
) -> Result<T, LlmError>
where
    F: FnMut(u32) -> Fut,
    Fut: Future<Output = Result<T, LlmError>>,
    R: Fn(&LlmError) -> bool,
    S: FnMut(u64) -> SleepFut,
    SleepFut: Future<Output = ()>,
{
    let max_attempts = max_attempts.max(1);
    if !classify || max_attempts <= 1 {
        return call(1).await;
    }

    let mut attempt = 1u32;
    loop {
        match call(attempt).await {
            Ok(value) => return Ok(value),
            Err(error) if is_context_overflow(&error) => return Err(error),
            Err(error) if attempt >= max_attempts || !is_retryable(&error) => return Err(error),
            Err(error) => {
                let delay = retry_delay_ms(&error, backoff_delay_ms(attempt));
                sleep(delay).await;
                attempt += 1;
            }
        }
    }
}

/// Delay before the next try. A server hint wins, clamped to one minute.
/// A rate limit with no hint is allowed to grow past the normal 5s cap.
pub fn retry_delay_ms(error: &LlmError, backoff_delay_ms: u64) -> u64 {
    if let Some(hint) = retry_after_ms(error) {
        return hint.min(RATE_LIMIT_MAX_TIMEOUT_MS);
    }
    if is_rate_limit(error) {
        return backoff_delay_ms
            .saturating_mul(RETRY_FACTOR)
            .min(RATE_LIMIT_MAX_TIMEOUT_MS);
    }
    backoff_delay_ms
}

/// Exponential backoff for the failure at `failed_attempt` (1-based).
/// The first retry waits 300ms, then 600ms, capped at 5s. No jitter: the
/// TypeScript helper randomizes, and tests here lock the unjittered curve.
pub fn backoff_delay_ms(failed_attempt: u32) -> u64 {
    let mut delay = RETRY_MIN_TIMEOUT_MS;
    for _ in 1..failed_attempt.max(1) {
        delay = delay.saturating_mul(RETRY_FACTOR).min(RETRY_MAX_TIMEOUT_MS);
    }
    delay
}

/// Status plus message, matching `isContextOverflowStatusError`.
pub fn is_context_overflow(error: &LlmError) -> bool {
    let LlmError::Api {
        status, message, ..
    } = error
    else {
        return false;
    };
    matches!(status, 400 | 413 | 422) && overflow_message(message)
}

/// Connection failures and the status codes `isRetryableGenerateError` retries.
/// Overflow is not retryable even when the status would otherwise qualify.
pub fn is_retryable_llm_error(error: &LlmError) -> bool {
    if is_context_overflow(error) {
        return false;
    }
    match error {
        LlmError::Http(_) => true,
        LlmError::Api { status, .. } => matches!(status, 429 | 500 | 502 | 503 | 504),
        _ => false,
    }
}

fn retry_after_ms(error: &LlmError) -> Option<u64> {
    match error {
        LlmError::Api {
            retry_after_ms: Some(delay),
            ..
        } => Some(*delay),
        _ => None,
    }
}

fn is_rate_limit(error: &LlmError) -> bool {
    match error {
        LlmError::Api { status: 429, .. } => true,
        LlmError::Api { message, .. } => rate_limit_message(message),
        _ => false,
    }
}

fn overflow_message(message: &str) -> bool {
    overflow_patterns()
        .iter()
        .any(|pattern| pattern.is_match(&message.to_lowercase()))
}

fn rate_limit_message(message: &str) -> bool {
    rate_limit_patterns()
        .iter()
        .any(|pattern| pattern.is_match(&message.to_lowercase()))
}

fn overflow_patterns() -> &'static [regex::Regex] {
    static PATTERNS: std::sync::OnceLock<Vec<regex::Regex>> = std::sync::OnceLock::new();
    PATTERNS.get_or_init(|| {
        [
            r"context[ _-]?length",
            r"(?:context[ _-]?window.*exceed|exceed.*context[ _-]?window)",
            r"maximum context",
            r"exceed(?:ed|s|ing)?\s+(?:the\s+)?max(?:imum)?\s+tokens?",
            r"(?:too many tokens.*(?:prompt|input|context)|(?:prompt|input|context).*too many tokens)",
            r"prompt is too long.*maximum",
            r"input token count.*exceeds?.*maximum number of tokens",
            r"request.*exceed(?:ed|s|ing)?.*model token limit",
        ]
        .into_iter()
        .map(|pattern| regex::Regex::new(pattern).expect("overflow pattern"))
        .collect()
    })
}

fn rate_limit_patterns() -> &'static [regex::Regex] {
    static PATTERNS: std::sync::OnceLock<Vec<regex::Regex>> = std::sync::OnceLock::new();
    PATTERNS.get_or_init(|| {
        [
            r"(?:apistatuserror.*429|429.*apistatuserror)",
            r"429.*too many requests",
            r"too many requests",
            r"provider\.rate_limit",
            r"reached .*max rpm",
            r"rate[ _-]?limit(?:ed)?",
            r"rate-limited",
        ]
        .into_iter()
        .map(|pattern| regex::Regex::new(pattern).expect("rate-limit pattern"))
        .collect()
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU32, Ordering};

    fn api(status: u16, message: &str, retry_after_ms: Option<u64>) -> LlmError {
        LlmError::Api {
            status,
            message: message.to_string(),
            retry_after_ms,
        }
    }

    #[tokio::test]
    async fn overflow_surfaces_on_the_first_attempt_even_if_every_error_is_retryable() {
        let calls = AtomicU32::new(0);
        let error = chat_with_retry(
            3,
            true,
            |_error: &LlmError| true,
            |_attempt| {
                calls.fetch_add(1, Ordering::SeqCst);
                async { Err::<&str, _>(api(400, "Context length exceeded", None)) }
            },
            |_delay| async {},
        )
        .await
        .unwrap_err();

        assert_eq!(calls.load(Ordering::SeqCst), 1);
        assert!(is_context_overflow(&error));
        assert!(!is_retryable_llm_error(&error));
    }

    #[tokio::test]
    async fn retries_a_transient_status_and_honors_a_zero_retry_after() {
        let calls = AtomicU32::new(0);
        let slept = std::sync::Mutex::new(Vec::new());
        let value = chat_with_retry(
            3,
            true,
            is_retryable_llm_error,
            |_attempt| {
                let n = calls.fetch_add(1, Ordering::SeqCst);
                async move {
                    if n == 0 {
                        Err(api(503, "unavailable", Some(0)))
                    } else {
                        Ok("ok")
                    }
                }
            },
            |delay| {
                slept.lock().unwrap().push(delay);
                async {}
            },
        )
        .await
        .unwrap();

        assert_eq!(value, "ok");
        assert_eq!(calls.load(Ordering::SeqCst), 2);
        assert_eq!(slept.lock().unwrap().as_slice(), &[0]);
    }

    #[tokio::test]
    async fn does_not_retry_when_classification_is_disabled() {
        let calls = AtomicU32::new(0);
        let error = chat_with_retry(
            3,
            false,
            |_error: &LlmError| true,
            |_attempt| {
                calls.fetch_add(1, Ordering::SeqCst);
                async { Err::<(), _>(api(503, "unavailable", Some(0))) }
            },
            |_delay| async {},
        )
        .await
        .unwrap_err();

        assert_eq!(calls.load(Ordering::SeqCst), 1);
        assert!(is_retryable_llm_error(&error));
    }

    #[test]
    fn retry_delay_honors_and_clamps_the_server_hint() {
        assert_eq!(
            retry_delay_ms(&api(429, "rate limited", Some(30_000)), 1_000),
            30_000
        );
        assert_eq!(
            retry_delay_ms(&api(503, "unavailable", Some(10 * 60_000)), 1_000),
            RATE_LIMIT_MAX_TIMEOUT_MS
        );
        assert_eq!(
            retry_delay_ms(&api(429, "rate limited", None), 5_000),
            10_000
        );
        assert_eq!(
            retry_delay_ms(&api(429, "rate limited", None), 40_000),
            RATE_LIMIT_MAX_TIMEOUT_MS
        );
        assert_eq!(retry_delay_ms(&api(503, "unavailable", None), 1_234), 1_234);
        assert_eq!(backoff_delay_ms(1), 300);
        assert_eq!(backoff_delay_ms(2), 600);
        assert_eq!(backoff_delay_ms(8), 5_000);
    }
}
