//! Plan mode: a read-only planning phase with a single writable plan file
//! (mirrors `packages/agent-core/src/agent/plan`).

use std::path::{Path, PathBuf};

/// Current plan identity + content for the UI.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PlanData {
    pub id: String,
    pub content: String,
    pub path: PathBuf,
}

/// Tracks whether plan mode is active and where the plan file lives.
#[derive(Debug, Default)]
pub struct PlanMode {
    active: bool,
    plan_id: Option<String>,
    plan_path: Option<PathBuf>,
}

impl PlanMode {
    pub fn is_active(&self) -> bool {
        self.active
    }

    /// Path of the current plan file, when plan mode is active.
    pub fn plan_path(&self) -> Option<&Path> {
        self.plan_path.as_deref()
    }

    pub fn plan_id(&self) -> Option<&str> {
        self.plan_id.as_deref()
    }

    /// Enter plan mode. Creates the plan directory and (when `create_file`)
    /// an empty plan file. Plans live under `<base_dir>/plans/<id>.md`.
    pub fn enter(&mut self, base_dir: &Path, create_file: bool) -> std::io::Result<PathBuf> {
        if self.active {
            return Err(std::io::Error::new(
                std::io::ErrorKind::AlreadyExists,
                "already in plan mode",
            ));
        }
        let id = generate_plan_id();
        let path = base_dir.join("plans").join(format!("{id}.md"));
        std::fs::create_dir_all(base_dir.join("plans"))?;
        if create_file {
            std::fs::write(&path, "")?;
        }
        self.active = true;
        self.plan_id = Some(id);
        self.plan_path = Some(path.clone());
        Ok(path)
    }

    /// Leave plan mode (approval accepted or cancelled).
    pub fn exit(&mut self) {
        self.active = false;
        self.plan_id = None;
        self.plan_path = None;
    }

    /// Truncate the plan file.
    pub fn clear(&mut self) -> std::io::Result<()> {
        if let Some(path) = &self.plan_path {
            std::fs::write(path, "")?;
        }
        Ok(())
    }

    /// Read the current plan (a missing file counts as empty; other IO
    /// errors also degrade to empty content so plan reads never fail the
    /// caller — the TS implementation propagates non-ENOENT errors).
    pub fn data(&self) -> Option<PlanData> {
        let id = self.plan_id.clone()?;
        let path = self.plan_path.clone()?;
        let content = std::fs::read_to_string(&path).unwrap_or_default();
        Some(PlanData { id, content, path })
    }
}

/// Short random id (`plan-<8 hex>`), the Rust stand-in for the TS hero slug.
/// A process-wide counter guarantees uniqueness within one run.
fn generate_plan_id() -> String {
    use std::sync::atomic::{AtomicU32, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};
    static COUNTER: AtomicU32 = AtomicU32::new(0);
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or(0);
    let counter = COUNTER.fetch_add(1, Ordering::Relaxed);
    let mixed =
        nanos ^ (nanos >> 33) ^ ((std::process::id() as u128) << 17) ^ ((counter as u128) << 41);
    format!("plan-{:08x}", (mixed & 0xffff_ffff) as u32)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_base(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("lmcode-plan-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn enters_and_exits_with_a_plan_file() {
        let base = temp_base("enter");
        let mut plan = PlanMode::default();
        assert!(!plan.is_active());
        let path = plan.enter(&base, true).unwrap();
        assert!(plan.is_active());
        assert!(path.exists());
        assert!(path.starts_with(base.join("plans")));

        std::fs::write(&path, "# the plan").unwrap();
        let data = plan.data().unwrap();
        assert_eq!(data.content, "# the plan");
        assert_eq!(data.path, path);
        assert!(data.id.starts_with("plan-"));

        plan.clear().unwrap();
        assert_eq!(plan.data().unwrap().content, "");

        plan.exit();
        assert!(!plan.is_active());
        assert!(plan.data().is_none());
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn double_enter_is_rejected() {
        let base = temp_base("double");
        let mut plan = PlanMode::default();
        plan.enter(&base, false).unwrap();
        assert!(plan.enter(&base, false).is_err());
        let _ = std::fs::remove_dir_all(&base);
    }
}
