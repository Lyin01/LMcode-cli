//! Computer-use capability: one provider slot, driver launch settings, and
//! the activation order from `packages/agent-core/src/computer-use`.
//!
//! The controller decides when a slot is taken, rolled back, or kept. Spawning
//! the driver is [`ComputerUseHost`]'s job, so these tests never start a process.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use async_trait::async_trait;

use crate::config::ComputerUsePermissionMode;

/// Environment variable the driver reads to fix its permission mode at launch.
pub const PERMISSION_MODE_ENV: &str = "CUA_DRIVER_PERMISSION_MODE";

/// Acknowledgement the driver requires before it will serve `unrestricted`.
pub const BYPASS_APPROVALS_ENV: &str = "CUA_DRIVER_DANGEROUSLY_BYPASS_APPROVALS";

const DEFAULT_PROVIDER_ID: &str = "cua-driver-mcp";

/// Host OS layouts the vendor installer is known to use.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HostPlatform {
    Windows,
    Unix,
}

/// Provider-owned identity. Only `cua-driver-mcp` ships today.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ComputerUseProvider {
    pub id: String,
    pub label: String,
    pub server_name: String,
    pub tool_name_prefix: String,
    pub default_command: String,
    pub default_args: Vec<String>,
    pub docs_url: String,
}

/// How to obtain the driver on this platform.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InstallRecipe {
    pub program: String,
    pub args: Vec<String>,
    pub manual_command: String,
}

/// What the controller asks the host to spawn.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ComputerUseLaunch {
    pub command: String,
    pub args: Vec<String>,
    pub env: HashMap<String, String>,
}

/// Connection the host reports for one server name.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ComputerUseConnection {
    Connected,
    Disabled,
    Failed,
}

/// Snapshot the controller reads. Tool count is whatever the host has listed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ComputerUseServerView {
    pub status: ComputerUseConnection,
    pub tool_count: usize,
    pub error: Option<String>,
}

/// Lifecycle phase inside one session.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ComputerUsePhase {
    Idle,
    Starting,
    Active,
    Failed,
}

/// Observable capability state.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ComputerUseStatus {
    pub phase: ComputerUsePhase,
    pub provider_id: String,
    pub label: String,
    pub server_name: String,
    pub tool_count: usize,
    pub permission_mode: ComputerUsePermissionMode,
    pub error: Option<String>,
}

/// Operator inputs for one activation. Omitted fields use the provider defaults.
#[derive(Debug, Clone, Default)]
pub struct ComputerUseActivation {
    pub provider_id: Option<String>,
    pub command: Option<String>,
    pub args: Option<Vec<String>>,
    pub permission_mode: Option<ComputerUsePermissionMode>,
}

/// Exclusive named registration. A second register fails even for the same name.
#[derive(Debug, Default)]
pub struct ComputerUseRegistry {
    slot: Option<(String, u64)>,
    next_token: u64,
}

/// Copyable so a repeated release can be ignored without freeing a newer holder.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RegistrationToken(u64);

impl ComputerUseRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    /// Name of the registered provider, including while its resources are closing.
    pub fn provider_name(&self) -> Option<&str> {
        self.slot.as_ref().map(|(name, _)| name.as_str())
    }

    /// Reserve the sole slot. The returned token is the only one that can release it.
    pub fn register(&mut self, name: &str) -> Result<RegistrationToken, String> {
        if let Some((current, _)) = &self.slot {
            return Err(format!(
                "Computer use provider \"{current}\" is already registered"
            ));
        }
        self.next_token = self.next_token.saturating_add(1);
        let token = RegistrationToken(self.next_token);
        self.slot = Some((name.to_string(), token.0));
        Ok(token)
    }

    /// Hand the slot back. A token that already released, or an older token, does nothing.
    pub fn release(&mut self, token: RegistrationToken) {
        if self
            .slot
            .as_ref()
            .is_some_and(|(_, generation)| *generation == token.0)
        {
            self.slot = None;
        }
    }
}

pub fn computer_use_provider(id: &str) -> Option<ComputerUseProvider> {
    if id == DEFAULT_PROVIDER_ID {
        Some(default_provider())
    } else {
        None
    }
}

fn default_provider() -> ComputerUseProvider {
    ComputerUseProvider {
        id: DEFAULT_PROVIDER_ID.to_string(),
        label: "Cua Driver (MCP)".to_string(),
        server_name: DEFAULT_PROVIDER_ID.to_string(),
        tool_name_prefix: "mcp__cua-driver-mcp__".to_string(),
        default_command: "cua-driver".to_string(),
        default_args: vec!["mcp".to_string()],
        docs_url: "https://cua.ai/docs/how-to-guides/driver/connect-your-agent".to_string(),
    }
}

/// Absolute locations the vendor installer uses, most-preferred first.
pub fn driver_candidates(platform: HostPlatform, env: &HashMap<String, String>) -> Vec<PathBuf> {
    match platform {
        HostPlatform::Windows => {
            let Some(local) = env.get("LOCALAPPDATA").filter(|value| !value.is_empty()) else {
                return Vec::new();
            };
            let base = PathBuf::from(local);
            vec![
                base.join("Programs")
                    .join("Cua")
                    .join("cua-driver")
                    .join("bin")
                    .join("cua-driver.exe"),
                base.join("Programs")
                    .join("trycua")
                    .join("cua-driver-rs")
                    .join("bin")
                    .join("cua-driver.exe"),
            ]
        }
        HostPlatform::Unix => {
            let mut candidates = Vec::new();
            if let Some(home) = env.get("HOME").filter(|value| !value.is_empty()) {
                candidates.push(
                    PathBuf::from(home)
                        .join(".local")
                        .join("bin")
                        .join("cua-driver"),
                );
            }
            candidates.push(PathBuf::from("/usr/local/bin/cua-driver"));
            candidates.push(PathBuf::from("/opt/homebrew/bin/cua-driver"));
            candidates
        }
    }
}

pub fn detect_driver(
    platform: HostPlatform,
    env: &HashMap<String, String>,
    exists: &dyn Fn(&Path) -> bool,
) -> Option<PathBuf> {
    driver_candidates(platform, env)
        .into_iter()
        .find(|candidate| exists(candidate))
}

pub fn resolve_computer_use_command(
    command: &str,
    provider: &ComputerUseProvider,
    platform: HostPlatform,
    env: &HashMap<String, String>,
    exists: &dyn Fn(&Path) -> bool,
) -> String {
    if command.contains('/') || command.contains('\\') || command != provider.default_command {
        return command.to_string();
    }
    detect_driver(platform, env, exists)
        .map(|path| path.to_string_lossy().into_owned())
        .unwrap_or_else(|| command.to_string())
}

pub fn install_recipe(platform: HostPlatform) -> InstallRecipe {
    match platform {
        HostPlatform::Windows => {
            let script = [
                "$ErrorActionPreference = 'Stop'",
                "$installer = Join-Path $env:TEMP 'cua-driver-install.ps1'",
                "Invoke-WebRequest -UseBasicParsing -Uri 'https://cua.ai/driver/install.ps1' -OutFile $installer",
                "& $installer -NoAutoStart",
            ]
            .join("; ");
            InstallRecipe {
                program: "powershell.exe".to_string(),
                args: vec![
                    "-NoProfile".to_string(),
                    "-ExecutionPolicy".to_string(),
                    "Bypass".to_string(),
                    "-Command".to_string(),
                    script,
                ],
                manual_command: "irm https://cua.ai/driver/install.ps1 | iex".to_string(),
            }
        }
        HostPlatform::Unix => InstallRecipe {
            program: "bash".to_string(),
            args: vec![
                "-c".to_string(),
                "curl -fsSL https://cua.ai/driver/install.sh | bash".to_string(),
            ],
            manual_command: "/bin/bash -c \"$(curl -fsSL https://cua.ai/driver/install.sh)\""
                .to_string(),
        },
    }
}

fn permission_env(mode: ComputerUsePermissionMode) -> HashMap<String, String> {
    let mode_value = match mode {
        ComputerUsePermissionMode::Standard => "standard",
        ComputerUsePermissionMode::Bounded => "bounded",
        ComputerUsePermissionMode::Unrestricted => "unrestricted",
    };
    let mut env = HashMap::new();
    env.insert(PERMISSION_MODE_ENV.to_string(), mode_value.to_string());
    if mode == ComputerUsePermissionMode::Unrestricted {
        env.insert(BYPASS_APPROVALS_ENV.to_string(), "1".to_string());
    }
    env
}

/// The process boundary. The controller never spawns; a host connects MCP.
#[async_trait]
pub trait ComputerUseHost {
    fn get(&self, name: &str) -> Option<ComputerUseServerView>;
    async fn add_server(&mut self, name: &str, launch: &ComputerUseLaunch) -> Result<(), String>;
    async fn reconnect(&mut self, name: &str) -> Result<(), String>;
    async fn remove_server(&mut self, name: &str) -> Result<(), String>;
    async fn stop_server(&mut self, name: &str) -> Result<(), String>;
}

struct Hold {
    descriptor: ComputerUseProvider,
    token: RegistrationToken,
    command: String,
    args: Vec<String>,
    permission_mode: ComputerUsePermissionMode,
    owned_entry: bool,
    connected: bool,
}

/// Owns the computer-use capability for one session.
pub struct ComputerUseController<H> {
    registry: ComputerUseRegistry,
    host: H,
    platform: HostPlatform,
    env: HashMap<String, String>,
    exists: Box<dyn Fn(&Path) -> bool + Send>,
    hold: Option<Hold>,
    last_error: Option<String>,
    starting: bool,
}

impl<H: ComputerUseHost> ComputerUseController<H> {
    pub fn new(
        host: H,
        platform: HostPlatform,
        env: HashMap<String, String>,
        exists: impl Fn(&Path) -> bool + Send + 'static,
    ) -> Self {
        Self {
            registry: ComputerUseRegistry::new(),
            host,
            platform,
            env,
            exists: Box::new(exists),
            hold: None,
            last_error: None,
            starting: false,
        }
    }

    pub fn host(&self) -> &H {
        &self.host
    }

    pub fn host_mut(&mut self) -> &mut H {
        &mut self.host
    }

    pub fn provider_registry(&mut self) -> &mut ComputerUseRegistry {
        &mut self.registry
    }

    pub fn provider_name(&self) -> Option<&str> {
        self.registry.provider_name()
    }

    pub fn is_active(&mut self) -> bool {
        self.observe();
        self.hold.is_some() && self.last_error.is_none() && !self.starting
    }

    pub fn detected_driver_path(&self) -> Option<PathBuf> {
        detect_driver(self.platform, &self.env, self.exists.as_ref())
    }

    pub fn status(&mut self) -> ComputerUseStatus {
        self.observe();
        let descriptor = self
            .hold
            .as_ref()
            .map(|hold| hold.descriptor.clone())
            .unwrap_or_else(default_provider);
        let phase = if self.hold.is_none() {
            if self.last_error.is_none() {
                ComputerUsePhase::Idle
            } else {
                ComputerUsePhase::Failed
            }
        } else if self.starting {
            ComputerUsePhase::Starting
        } else if self.last_error.is_none() {
            ComputerUsePhase::Active
        } else {
            ComputerUsePhase::Failed
        };
        let tool_count = if self.hold.is_none() {
            0
        } else {
            self.host
                .get(&descriptor.server_name)
                .map(|entry| entry.tool_count)
                .unwrap_or(0)
        };
        ComputerUseStatus {
            phase,
            provider_id: descriptor.id,
            label: descriptor.label,
            server_name: descriptor.server_name,
            tool_count,
            permission_mode: self
                .hold
                .as_ref()
                .map(|hold| hold.permission_mode)
                .unwrap_or(ComputerUsePermissionMode::Standard),
            error: self.last_error.clone(),
        }
    }

    /// Reserve the slot before anything is spawned, then connect the provider.
    ///
    /// A live capability returns its current status. A provider that never
    /// connected releases the slot. A provider that drops after serving keeps it.
    pub async fn activate(&mut self, settings: ComputerUseActivation) -> ComputerUseStatus {
        self.starting = true;
        let descriptor = settings
            .provider_id
            .as_deref()
            .map(computer_use_provider)
            .unwrap_or_else(|| Some(default_provider()));
        if let Err(error) = self.activate_with(descriptor.clone(), &settings).await {
            self.last_error = Some(match &descriptor {
                Some(provider) => self.describe_failure(provider, &error),
                None => error,
            });
            self.release_never_started().await;
        }
        self.starting = false;
        self.status()
    }

    /// Stop the provider, then hand the slot back. A stale failure returns to idle.
    pub async fn deactivate(&mut self) {
        let Some(hold) = self.hold.take() else {
            self.last_error = None;
            return;
        };
        let name = hold.descriptor.server_name.clone();
        if hold.owned_entry {
            let _ = self.host.remove_server(&name).await;
        } else {
            let _ = self.host.stop_server(&name).await;
        }
        self.registry.release(hold.token);
        self.last_error = None;
    }

    async fn activate_with(
        &mut self,
        descriptor: Option<ComputerUseProvider>,
        settings: &ComputerUseActivation,
    ) -> Result<(), String> {
        let Some(descriptor) = descriptor else {
            let requested = settings.provider_id.as_deref().unwrap_or("");
            return Err(format!("Unknown computer use provider \"{requested}\""));
        };
        if self.hold.is_none() {
            self.reserve(descriptor, settings)?;
        }
        self.ensure_connected().await?;
        self.last_error = None;
        Ok(())
    }

    fn reserve(
        &mut self,
        descriptor: ComputerUseProvider,
        settings: &ComputerUseActivation,
    ) -> Result<(), String> {
        let token = self.registry.register(&descriptor.id)?;
        let configured = settings
            .command
            .clone()
            .unwrap_or_else(|| descriptor.default_command.clone());
        let command = resolve_computer_use_command(
            &configured,
            &descriptor,
            self.platform,
            &self.env,
            self.exists.as_ref(),
        );
        let args = settings
            .args
            .clone()
            .unwrap_or_else(|| descriptor.default_args.clone());
        let owned_entry = self.host.get(&descriptor.server_name).is_none();
        self.hold = Some(Hold {
            descriptor,
            token,
            command,
            args,
            permission_mode: settings
                .permission_mode
                .unwrap_or(ComputerUsePermissionMode::Standard),
            owned_entry,
            connected: false,
        });
        Ok(())
    }

    async fn ensure_connected(&mut self) -> Result<(), String> {
        let (name, launch, needs_add, needs_reconnect) = {
            let hold = self.hold.as_ref().expect("computer use slot is reserved");
            let name = hold.descriptor.server_name.clone();
            let launch = ComputerUseLaunch {
                command: hold.command.clone(),
                args: hold.args.clone(),
                env: permission_env(hold.permission_mode),
            };
            let existing = self.host.get(&name);
            let needs_add = existing.is_none();
            let needs_reconnect = existing
                .as_ref()
                .is_some_and(|entry| entry.status != ComputerUseConnection::Connected);
            (name, launch, needs_add, needs_reconnect)
        };
        if needs_add {
            self.host.add_server(&name, &launch).await?;
        } else if needs_reconnect {
            self.host.reconnect(&name).await?;
        }
        match self.host.get(&name) {
            Some(entry) if entry.status == ComputerUseConnection::Connected => {
                if let Some(hold) = self.hold.as_mut() {
                    hold.connected = true;
                }
                Ok(())
            }
            Some(entry) => Err(entry.error.unwrap_or_else(|| {
                format!(
                    "Computer use provider \"{name}\" is {}",
                    status_word(entry.status)
                )
            })),
            None => Err(format!("Computer use provider \"{name}\" is missing")),
        }
    }

    async fn release_never_started(&mut self) {
        let Some(hold) = self.hold.take_if(|hold| !hold.connected) else {
            return;
        };
        if hold.owned_entry {
            let _ = self.host.remove_server(&hold.descriptor.server_name).await;
        }
        self.registry.release(hold.token);
    }

    fn observe(&mut self) {
        let Some(hold) = &self.hold else {
            return;
        };
        if !hold.connected {
            return;
        }
        let name = hold.descriptor.server_name.clone();
        let Some(entry) = self.host.get(&name) else {
            return;
        };
        self.last_error = match entry.status {
            ComputerUseConnection::Connected => None,
            ComputerUseConnection::Failed => Some(
                entry
                    .error
                    .unwrap_or_else(|| "Computer use provider disconnected".to_string()),
            ),
            ComputerUseConnection::Disabled => {
                Some("Computer use provider was stopped".to_string())
            }
        };
    }

    fn describe_failure(&self, provider: &ComputerUseProvider, detail: &str) -> String {
        if self.detected_driver_path().is_some() {
            return format!("{}: {detail}", provider.label);
        }
        let recipe = install_recipe(self.platform);
        format!(
            "{}: {detail} — install the driver with: {}",
            provider.label, recipe.manual_command
        )
    }
}

fn status_word(status: ComputerUseConnection) -> &'static str {
    match status {
        ComputerUseConnection::Connected => "connected",
        ComputerUseConnection::Disabled => "disabled",
        ComputerUseConnection::Failed => "failed",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Default)]
    struct FakeHost {
        servers: HashMap<String, FakeEntry>,
        adds: usize,
    }

    struct FakeEntry {
        status: ComputerUseConnection,
        tool_count: usize,
        error: Option<String>,
        launch: ComputerUseLaunch,
    }

    impl FakeHost {
        fn fail_launch(launch: &ComputerUseLaunch) -> bool {
            launch.command == "cua-driver-not-installed"
                || launch.args.iter().any(|arg| arg.contains("does-not-exist"))
        }

        fn mark_failed(&mut self, name: &str) {
            let entry = self.servers.get_mut(name).expect("server");
            entry.status = ComputerUseConnection::Failed;
            entry.error = Some("provider disconnected".to_string());
        }

        fn seed_connected(&mut self, name: &str) {
            self.servers.insert(
                name.to_string(),
                FakeEntry {
                    status: ComputerUseConnection::Connected,
                    tool_count: 4,
                    error: None,
                    launch: ComputerUseLaunch {
                        command: "operator".to_string(),
                        args: vec!["mcp".to_string()],
                        env: HashMap::new(),
                    },
                },
            );
        }
    }

    #[async_trait]
    impl ComputerUseHost for FakeHost {
        fn get(&self, name: &str) -> Option<ComputerUseServerView> {
            self.servers.get(name).map(|entry| ComputerUseServerView {
                status: entry.status,
                tool_count: entry.tool_count,
                error: entry.error.clone(),
            })
        }

        async fn add_server(
            &mut self,
            name: &str,
            launch: &ComputerUseLaunch,
        ) -> Result<(), String> {
            if Self::fail_launch(launch) {
                return Err(format!("failed to start {}", launch.command));
            }
            self.adds += 1;
            self.servers.insert(
                name.to_string(),
                FakeEntry {
                    status: ComputerUseConnection::Connected,
                    tool_count: 4,
                    error: None,
                    launch: launch.clone(),
                },
            );
            Ok(())
        }

        async fn reconnect(&mut self, name: &str) -> Result<(), String> {
            let entry = self
                .servers
                .get_mut(name)
                .ok_or_else(|| format!("missing {name}"))?;
            entry.status = ComputerUseConnection::Connected;
            entry.error = None;
            entry.tool_count = 4;
            Ok(())
        }

        async fn remove_server(&mut self, name: &str) -> Result<(), String> {
            self.servers.remove(name);
            Ok(())
        }

        async fn stop_server(&mut self, name: &str) -> Result<(), String> {
            let entry = self
                .servers
                .get_mut(name)
                .ok_or_else(|| format!("missing {name}"))?;
            entry.status = ComputerUseConnection::Disabled;
            entry.tool_count = 0;
            Ok(())
        }
    }

    fn controller() -> ComputerUseController<FakeHost> {
        ComputerUseController::new(
            FakeHost::default(),
            HostPlatform::Unix,
            HashMap::new(),
            |_| false,
        )
    }

    fn launch_driver() -> ComputerUseActivation {
        ComputerUseActivation {
            command: Some("node".to_string()),
            args: Some(vec!["cua-driver-mock.mjs".to_string()]),
            ..ComputerUseActivation::default()
        }
    }

    fn permission_env_of(host: &FakeHost) -> (Option<String>, Option<String>) {
        let launch = &host.servers["cua-driver-mcp"].launch;
        (
            launch.env.get(PERMISSION_MODE_ENV).cloned(),
            launch.env.get(BYPASS_APPROVALS_ENV).cloned(),
        )
    }

    #[test]
    fn registry_reports_the_name_until_release_and_ignores_a_second_release() {
        let mut registry = ComputerUseRegistry::new();
        assert!(registry.provider_name().is_none());

        let release = registry.register("cua-driver-mcp").unwrap();
        assert_eq!(registry.provider_name(), Some("cua-driver-mcp"));
        registry.release(release);
        assert!(registry.provider_name().is_none());

        let again = registry.register("cua-driver-mcp").unwrap();
        registry.release(release);
        assert_eq!(registry.provider_name(), Some("cua-driver-mcp"));
        registry.release(again);
        assert!(registry.provider_name().is_none());
    }

    #[test]
    fn registry_refuses_a_second_registration_even_for_the_same_name() {
        let mut registry = ComputerUseRegistry::new();
        registry.register("cua-driver-mcp").unwrap();
        let error = registry.register("cua-driver-mcp").unwrap_err();
        assert!(error.contains("already registered"), "{error}");
        assert_eq!(registry.provider_name(), Some("cua-driver-mcp"));
    }

    #[test]
    fn bare_default_command_upgrades_to_a_detected_driver_path() {
        let provider = default_provider();
        let mut env = HashMap::new();
        env.insert("HOME".to_string(), "/home/lm".to_string());
        let expected = PathBuf::from("/home/lm")
            .join(".local")
            .join("bin")
            .join("cua-driver");
        let resolved = resolve_computer_use_command(
            "cua-driver",
            &provider,
            HostPlatform::Unix,
            &env,
            &|path| path == expected,
        );
        assert_eq!(PathBuf::from(resolved), expected);

        let explicit = resolve_computer_use_command(
            "custom-driver",
            &provider,
            HostPlatform::Unix,
            &env,
            &|_| true,
        );
        assert_eq!(explicit, "custom-driver");
    }

    #[tokio::test]
    async fn activate_reserves_the_slot_connects_and_reports_tools() {
        let mut subject = controller();
        let status = subject.activate(launch_driver()).await;
        assert_eq!(status.phase, ComputerUsePhase::Active);
        assert_eq!(status.provider_id, "cua-driver-mcp");
        assert_eq!(status.server_name, "cua-driver-mcp");
        assert_eq!(status.tool_count, 4);
        assert!(status.error.is_none());
        assert!(subject.is_active());
        assert_eq!(subject.provider_name(), Some("cua-driver-mcp"));
        assert_eq!(
            subject.host().get("cua-driver-mcp").unwrap().status,
            ComputerUseConnection::Connected
        );
    }

    #[tokio::test]
    async fn unrestricted_mode_sends_the_bypass_acknowledgement() {
        let mut subject = controller();
        let status = subject
            .activate(ComputerUseActivation {
                command: Some("node".to_string()),
                args: Some(vec!["cua-driver-mock.mjs".to_string()]),
                permission_mode: Some(ComputerUsePermissionMode::Unrestricted),
                ..ComputerUseActivation::default()
            })
            .await;
        assert_eq!(status.phase, ComputerUsePhase::Active);
        assert_eq!(
            status.permission_mode,
            ComputerUsePermissionMode::Unrestricted
        );
        assert_eq!(
            permission_env_of(subject.host()),
            (Some("unrestricted".to_string()), Some("1".to_string()))
        );
    }

    #[tokio::test]
    async fn standard_mode_does_not_send_the_bypass_acknowledgement() {
        let mut subject = controller();
        subject.activate(launch_driver()).await;
        assert_eq!(
            permission_env_of(subject.host()),
            (Some("standard".to_string()), None)
        );
    }

    #[tokio::test]
    async fn a_second_activate_does_not_spawn_another_driver() {
        let mut subject = controller();
        subject.activate(launch_driver()).await;
        let second = subject.activate(launch_driver()).await;
        assert_eq!(second.phase, ComputerUsePhase::Active);
        assert_eq!(subject.host().servers.len(), 1);
        assert_eq!(subject.host().adds, 1);
    }

    #[tokio::test]
    async fn deactivate_releases_the_slot_and_a_later_activate_works() {
        let mut subject = controller();
        subject.activate(launch_driver()).await;
        subject.deactivate().await;
        assert!(!subject.is_active());
        assert!(subject.provider_name().is_none());
        assert!(subject.host().get("cua-driver-mcp").is_none());
        assert_eq!(subject.status().phase, ComputerUsePhase::Idle);

        let again = subject.activate(launch_driver()).await;
        assert_eq!(again.phase, ComputerUsePhase::Active);
    }

    #[tokio::test]
    async fn a_failed_activation_frees_the_slot_so_a_retry_can_connect() {
        let mut subject = controller();
        let failed = subject
            .activate(ComputerUseActivation {
                command: Some("node".to_string()),
                args: Some(vec!["does-not-exist.mjs".to_string()]),
                ..ComputerUseActivation::default()
            })
            .await;
        assert_eq!(failed.phase, ComputerUsePhase::Failed);
        assert!(subject.provider_name().is_none());

        let recovered = subject.activate(launch_driver()).await;
        assert_eq!(recovered.phase, ComputerUsePhase::Active);
        assert!(recovered.error.is_none());
    }

    #[tokio::test]
    async fn an_unknown_provider_is_a_failed_status_and_does_not_hold_the_slot() {
        let mut subject = controller();
        let status = subject
            .activate(ComputerUseActivation {
                provider_id: Some("not-a-provider".to_string()),
                ..ComputerUseActivation::default()
            })
            .await;
        assert_eq!(status.phase, ComputerUsePhase::Failed);
        let error = status.error.expect("error");
        assert!(error.contains("not-a-provider"), "{error}");
        assert!(subject.provider_name().is_none());
    }

    #[tokio::test]
    async fn deactivate_clears_a_stale_failure() {
        let mut subject = controller();
        subject
            .activate(ComputerUseActivation {
                command: Some("cua-driver-not-installed".to_string()),
                ..ComputerUseActivation::default()
            })
            .await;
        assert_eq!(subject.status().phase, ComputerUsePhase::Failed);
        subject.deactivate().await;
        let status = subject.status();
        assert_eq!(status.phase, ComputerUsePhase::Idle);
        assert!(status.error.is_none());
    }

    #[tokio::test]
    async fn a_missing_driver_names_the_install_command() {
        let mut subject = controller();
        let status = subject
            .activate(ComputerUseActivation {
                command: Some("cua-driver-not-installed".to_string()),
                ..ComputerUseActivation::default()
            })
            .await;
        assert_eq!(status.phase, ComputerUsePhase::Failed);
        let error = status.error.expect("error");
        assert!(error.contains("Cua Driver"), "{error}");
        assert!(error.contains("install"), "{error}");
        assert!(subject.provider_name().is_none());
    }

    #[tokio::test]
    async fn an_operator_owned_entry_is_stopped_instead_of_deleted() {
        let mut subject = controller();
        subject.host_mut().seed_connected("cua-driver-mcp");
        let status = subject.activate(launch_driver()).await;
        assert_eq!(status.phase, ComputerUsePhase::Active);
        assert_eq!(subject.host().adds, 0);

        subject.deactivate().await;
        let entry = subject.host().get("cua-driver-mcp").expect("kept");
        assert_eq!(entry.status, ComputerUseConnection::Disabled);
        assert!(subject.provider_name().is_none());
    }

    #[tokio::test]
    async fn a_second_provider_is_refused_while_the_slot_is_held() {
        let mut subject = controller();
        subject.activate(launch_driver()).await;
        let error = subject
            .provider_registry()
            .register("cua-driver-mcp")
            .unwrap_err();
        assert!(error.contains("already registered"), "{error}");
    }

    #[tokio::test]
    async fn a_lost_provider_fails_and_keeps_the_reservation() {
        let mut subject = controller();
        subject.activate(launch_driver()).await;
        subject.host_mut().mark_failed("cua-driver-mcp");
        let status = subject.status();
        assert_eq!(status.phase, ComputerUsePhase::Failed);
        assert_eq!(subject.provider_name(), Some("cua-driver-mcp"));

        let recovered = subject.activate(launch_driver()).await;
        assert_eq!(recovered.phase, ComputerUsePhase::Active);
        assert_eq!(subject.host().adds, 1);
        assert_eq!(subject.provider_name(), Some("cua-driver-mcp"));
    }
}
