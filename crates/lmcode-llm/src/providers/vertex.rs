//! Vertex AI provider (`vertexai`): Gemini `generateContent` served from
//! Google Cloud. Authenticates with an API key (Express mode) or a service
//! account JSON key exchanged for an OAuth2 access token (JWT bearer flow).
//!
//! Request/response mapping is shared with the Google GenAI provider in
//! [`super::genai`]; only the endpoint shape and authentication differ.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use tokio::sync::Mutex as AsyncMutex;

use crate::error::LlmError;
use crate::message::Message;
use crate::provider::{ChatProvider, GenerateOptions, StreamSummary, StreamedMessage};
use crate::tool::Tool;

use super::ProviderConfig;
use super::genai;

/// Default region when the provider config does not set one.
const DEFAULT_LOCATION: &str = "us-central1";
/// OAuth2 endpoint used to exchange the signed JWT for an access token.
const TOKEN_URL: &str = "https://oauth2.googleapis.com/token";
/// Refresh the token this many seconds before it actually expires.
const TOKEN_REFRESH_MARGIN_SECS: u64 = 60;
/// JWT lifetime (Google allows up to one hour).
const JWT_LIFETIME_SECS: u64 = 3600;
/// OAuth2 scope for Vertex AI calls.
const CLOUD_PLATFORM_SCOPE: &str = "https://www.googleapis.com/auth/cloud-platform";

/// Streaming provider for Vertex AI `streamGenerateContent`.
pub struct VertexProvider {
    name: String,
    model: String,
    project: String,
    location: String,
    base_url: String,
    api_key: Option<String>,
    credentials: Option<PathBuf>,
    headers: HashMap<String, String>,
    client: reqwest::Client,
    token: AsyncMutex<Option<CachedToken>>,
}

#[derive(Debug, Clone)]
struct CachedToken {
    access_token: String,
    /// Unix seconds after which the token must be refreshed.
    expires_at: u64,
}

impl VertexProvider {
    pub fn new(config: ProviderConfig) -> Result<Self, LlmError> {
        if config.model.trim().is_empty() {
            return Err(LlmError::Config(format!(
                "provider `{}` has no model selected",
                config.name
            )));
        }
        let project = config
            .project
            .filter(|value| !value.trim().is_empty())
            .ok_or_else(|| {
                LlmError::Config(format!(
                    "vertex provider `{}` requires a `project`",
                    config.name
                ))
            })?;
        let location = config
            .location
            .filter(|value| !value.trim().is_empty())
            .unwrap_or_else(|| DEFAULT_LOCATION.to_string());
        let api_key = config.api_key.filter(|value| !value.trim().is_empty());
        let credentials = config.credentials.filter(|value| !value.trim().is_empty());
        if api_key.is_none() && credentials.is_none() {
            return Err(LlmError::Config(format!(
                "vertex provider `{}` needs either an `api_key` or a `credentials` path",
                config.name
            )));
        }
        let base_url = config
            .base_url
            .filter(|url| !url.trim().is_empty())
            .unwrap_or_else(|| format!("https://{location}-aiplatform.googleapis.com"));
        Ok(Self {
            name: config.name,
            model: config.model,
            project,
            location,
            base_url,
            api_key,
            credentials: credentials.map(PathBuf::from),
            headers: config.headers,
            client: reqwest::Client::new(),
            token: AsyncMutex::new(None),
        })
    }

    /// Cached access token, refreshed when close to expiry.
    async fn access_token(&self) -> Result<String, LlmError> {
        let mut guard = self.token.lock().await;
        let now = unix_now();
        if let Some(token) = guard.as_ref()
            && token.expires_at > now + TOKEN_REFRESH_MARGIN_SECS
        {
            return Ok(token.access_token.clone());
        }
        let credentials = self.credentials.as_ref().ok_or_else(|| {
            LlmError::Config(format!(
                "vertex provider `{}` has no credentials configured",
                self.name
            ))
        })?;
        let token = fetch_service_account_token(&self.client, credentials).await?;
        let access = token.access_token.clone();
        *guard = Some(token);
        Ok(access)
    }
}

#[async_trait]
impl ChatProvider for VertexProvider {
    fn name(&self) -> &str {
        &self.name
    }

    fn model_name(&self) -> &str {
        &self.model
    }

    async fn generate(
        &self,
        system_prompt: &str,
        tools: &[Tool],
        history: &[Message],
        options: GenerateOptions,
    ) -> Result<StreamedMessage, LlmError> {
        let body = genai::build_request_body(system_prompt, tools, history);
        let url = format!(
            "{}/v1/projects/{}/locations/{}/publishers/google/models/{}:streamGenerateContent?alt=sse",
            self.base_url.trim_end_matches('/'),
            self.project,
            self.location,
            self.model
        );

        let mut request = self
            .client
            .post(&url)
            .header("accept", "text/event-stream")
            .json(&body);
        if let Some(api_key) = options.api_key.as_deref().or(self.api_key.as_deref()) {
            request = request.header("x-goog-api-key", api_key);
        } else {
            let token = self.access_token().await?;
            request = request.header("authorization", format!("Bearer {token}"));
        }
        for (name, value) in self.headers.iter().chain(options.headers.iter()) {
            request = request.header(name, value);
        }

        let response = request.send().await?;
        let status = response.status();
        if !status.is_success() {
            let body = response.text().await.unwrap_or_default();
            return Err(LlmError::Api {
                status: status.as_u16(),
                message: genai::extract_error_message(&body),
            });
        }

        let summary = Arc::new(Mutex::new(StreamSummary::default()));
        let parts = genai::build_parts_stream(response, Arc::clone(&summary));
        Ok(StreamedMessage::new(parts, summary))
    }
}

/// Subset of a GCP service account JSON key file.
#[derive(Debug, Deserialize)]
struct ServiceAccountKey {
    client_email: String,
    private_key: String,
    #[serde(default)]
    token_uri: Option<String>,
}

#[derive(Debug, Deserialize)]
struct TokenResponse {
    access_token: String,
    #[serde(default = "default_expires_in")]
    expires_in: u64,
}

fn default_expires_in() -> u64 {
    3600
}

/// Claims of the JWT-bearer assertion sent to the token endpoint.
#[derive(Debug, Serialize, Deserialize)]
struct AssertionClaims {
    iss: String,
    scope: String,
    aud: String,
    iat: u64,
    exp: u64,
}

/// Read a service account key file and exchange a signed JWT for an access
/// token.
async fn fetch_service_account_token(
    client: &reqwest::Client,
    path: &Path,
) -> Result<CachedToken, LlmError> {
    let text = std::fs::read_to_string(path).map_err(|source| {
        LlmError::Config(format!(
            "vertex: cannot read credentials `{}`: {source}",
            path.display()
        ))
    })?;
    let key: ServiceAccountKey = serde_json::from_str(&text).map_err(|source| {
        LlmError::Config(format!("vertex: invalid credentials JSON: {source}"))
    })?;
    let audience = key
        .token_uri
        .clone()
        .filter(|uri| !uri.trim().is_empty())
        .unwrap_or_else(|| TOKEN_URL.to_string());
    let now = unix_now();
    let assertion = build_jwt(&key.client_email, &key.private_key, &audience, now)?;
    let response = client
        .post(&audience)
        .form(&[
            ("grant_type", "urn:ietf:params:oauth:grant-type:jwt-bearer"),
            ("assertion", assertion.as_str()),
        ])
        .send()
        .await?;
    let status = response.status();
    if !status.is_success() {
        let body = response.text().await.unwrap_or_default();
        return Err(LlmError::Api {
            status: status.as_u16(),
            message: format!("vertex token exchange failed: {body}"),
        });
    }
    let token: TokenResponse = response.json().await.map_err(|source| LlmError::Api {
        status: status.as_u16(),
        message: format!("vertex token response parse failed: {source}"),
    })?;
    Ok(CachedToken {
        access_token: token.access_token,
        expires_at: now + token.expires_in,
    })
}

/// Build and sign the JWT-bearer assertion with the service account key.
fn build_jwt(
    client_email: &str,
    private_key_pem: &str,
    audience: &str,
    now: u64,
) -> Result<String, LlmError> {
    let claims = build_claims(client_email, audience, now);
    let key = jsonwebtoken::EncodingKey::from_rsa_pem(private_key_pem.as_bytes())
        .map_err(|source| LlmError::Config(format!("vertex: invalid private key: {source}")))?;
    jsonwebtoken::encode(
        &jsonwebtoken::Header::new(jsonwebtoken::Algorithm::RS256),
        &claims,
        &key,
    )
    .map_err(|source| LlmError::Config(format!("vertex: JWT signing failed: {source}")))
}

fn build_claims(client_email: &str, audience: &str, now: u64) -> AssertionClaims {
    AssertionClaims {
        iss: client_email.to_string(),
        scope: CLOUD_PLATFORM_SCOPE.to_string(),
        aud: audience.to_string(),
        iat: now,
        exp: now + JWT_LIFETIME_SECS,
    }
}

fn unix_now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Throwaway RSA key pair used only by these tests.
    const TEST_PRIVATE_KEY: &str = "\
-----BEGIN PRIVATE KEY-----
MIIEvAIBADANBgkqhkiG9w0BAQEFAASCBKYwggSiAgEAAoIBAQDJ0X3So2+jll4Z
iLogiPuIku6p5rmw/0siVnknREy0xP+NfEW8iWZYGeDJm9k2oDAkfJuy/ES0OlCg
miKHD/6oHf1GR3fXMHNW4PuVwiVxPU/V6ihpVr4itEXQWVnQ019NyYz9Psin7d7V
NwE3CvxC84uWgCpfbUXc/OmpLyzIZAjKIx7+BprB8XhNgGSyE2r6+N3NxyqAzWgL
itgjgy9y1upvZV+AJBTbsXeJjgdujULTWKL0vE5NMVKIw37wKCGpWR+vA8i1crvs
CsaII/Br73vtaBXslSz6LBWrPNQXLtBn7RJ97rRcFPYD3wZGqTpvMub9cgXi5/Rz
p6uZwKMDAgMBAAECggEAFOXP5mP3tz6RRN9EYq0R2rJYQJiRvtMDR9ggwyD5OQ4I
Zkapfpx9pVQcqNOt+iWRMUiujf89lVSlLP7ON3e/sfnU/ut/QcrpuTkiY/9OsDtI
jTPUy7+TKvXJdYm4WVLMf2Sw6DeRldigO9TDwpwtGI5ZHxRAuaaPgZK2FpzkwWUc
i0enG6IddTO8Ht6h7l+71VsZKuUPHMLxRBLcHFCVTxE6KG+kagE+cW26zBvRyldZ
AGjXf5gIJBg0H/Pr6MqQD/onybx7cNaK9o3lYvGZHathZgiK0odCBaZhRtaoCHpU
D22K92docr/6sHuaLhnWhkt5ySbYS5ABlc2wMgwdyQKBgQDwuMc0jRdcWXgEma6n
AHZmgjjSLjAldJ5mOHGcutJbsfMiFGDdUGjHcDxsBIaFRd24c87FUmOWSY33CDxL
o4HTujwPubtGVCKWuVCuDe4iETlOMPpbdmmeZifS7dkOAoU+c+sQnQ5CvsGthjvY
BCOMusXG6x6juiqgWlpZpc8HGQKBgQDWoJ0x3EGywvD/xFbM49SAWNNqatMbb+kk
QNUVVsvJ6hoG+igegiIiF//VvOZw6CQwPcgZ1mXhwDZyY2J+eZRo9i2ze3m4OAGR
XhOvgrrktUr74YnbXd3gHYlCPCAYhv1VmrFe01noTnkFlstjXGs8Vvpl2xY8My19
BhWB/3NKewKBgBRbK81P2RfgIPwSmuhYa6rDfFaZvUyNjg+K2mCsk7lZVPweyQou
EI48+X8Q6uc+Pz+n22ZoTy+YTL8FHUQwMXxcFVQnGqUZ3ErupNnzJ54N4tCv55vw
aYIRlXCK2H4MzIO5fblL7rbKNsqbvVfJEdCGws7NdyvVRGGHAnjuQpGRAoGAegUI
OY+aPlI8B30NSCEC8BEP6QFgkcm3B2hgfGhDJcEVGQBhjK65Tx7L0S066dfgsxh8
ycutUoIfsjq0hWkDqgTDiLXbRpN4uLd+g5rUPDCht7/Ky097U+4W2fQq3ybnoiJ3
UozgIYVzomzPpualBMICS6QZ6RHDe7/YvHaJij8CgYAXYAEBIcBqker+I6gvgS6i
0iR1UaDqMiROmd5kQ/cF6EW8QbGf6SJd+TYWFUtNVBmHp6+MpoeRgdMzz/qA2mPV
nY93pPYiVza8cNGWpk9nt0IFT0JwDOpt37d/YLWhG4K/NRZm2JpnVO/CGIRmYJc5
7urli2MA7xctRg7BOUQoSg==
-----END PRIVATE KEY-----
";

    const TEST_PUBLIC_KEY: &str = "\
-----BEGIN PUBLIC KEY-----
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAydF90qNvo5ZeGYi6IIj7
iJLuqea5sP9LIlZ5J0RMtMT/jXxFvIlmWBngyZvZNqAwJHybsvxEtDpQoJoihw/+
qB39Rkd31zBzVuD7lcIlcT1P1eooaVa+IrRF0FlZ0NNfTcmM/T7Ip+3e1TcBNwr8
QvOLloAqX21F3PzpqS8syGQIyiMe/gaawfF4TYBkshNq+vjdzccqgM1oC4rYI4Mv
ctbqb2VfgCQU27F3iY4Hbo1C01ii9LxOTTFSiMN+8CghqVkfrwPItXK77ArGiCPw
a+977WgV7JUs+iwVqzzUFy7QZ+0Sfe60XBT2A98GRqk6bzLm/XIF4uf0c6ermcCj
AwIDAQAB
-----END PUBLIC KEY-----
";

    fn base_config(
        project: Option<&str>,
        api_key: Option<&str>,
        credentials: Option<&str>,
    ) -> ProviderConfig {
        ProviderConfig {
            name: "vertex-test".to_string(),
            provider_type: super::super::ProviderType::VertexAi,
            model: "gemini-2.5-flash".to_string(),
            api_key: api_key.map(str::to_string),
            project: project.map(str::to_string),
            credentials: credentials.map(str::to_string),
            ..Default::default()
        }
    }

    #[test]
    fn builds_assertion_claims() {
        let claims = build_claims("svc@example.iam.gserviceaccount.com", TOKEN_URL, 1000);
        assert_eq!(claims.iss, "svc@example.iam.gserviceaccount.com");
        assert_eq!(claims.scope, CLOUD_PLATFORM_SCOPE);
        assert_eq!(claims.aud, TOKEN_URL);
        assert_eq!(claims.iat, 1000);
        assert_eq!(claims.exp, 1000 + JWT_LIFETIME_SECS);
    }

    #[test]
    fn signs_a_verifiable_jwt() {
        let jwt = build_jwt(
            "svc@example.iam.gserviceaccount.com",
            TEST_PRIVATE_KEY,
            TOKEN_URL,
            42,
        )
        .unwrap();
        let mut validation = jsonwebtoken::Validation::new(jsonwebtoken::Algorithm::RS256);
        validation.set_audience(&[TOKEN_URL]);
        validation.validate_exp = false;
        let key = jsonwebtoken::DecodingKey::from_rsa_pem(TEST_PUBLIC_KEY.as_bytes()).unwrap();
        let data = jsonwebtoken::decode::<AssertionClaims>(&jwt, &key, &validation).unwrap();
        assert_eq!(data.claims.iss, "svc@example.iam.gserviceaccount.com");
        assert_eq!(data.claims.iat, 42);
    }

    #[test]
    fn requires_project_and_auth() {
        assert!(VertexProvider::new(base_config(None, Some("k"), None)).is_err());
        assert!(VertexProvider::new(base_config(Some("p"), None, None)).is_err());
        let provider = VertexProvider::new(base_config(Some("p"), Some("k"), None)).unwrap();
        assert_eq!(
            provider.base_url,
            "https://us-central1-aiplatform.googleapis.com"
        );
    }

    #[test]
    fn location_shapes_the_default_base_url() {
        let mut config = base_config(Some("p"), Some("k"), None);
        config.location = Some("europe-west4".to_string());
        let provider = VertexProvider::new(config).unwrap();
        assert_eq!(
            provider.base_url,
            "https://europe-west4-aiplatform.googleapis.com"
        );
    }
}
