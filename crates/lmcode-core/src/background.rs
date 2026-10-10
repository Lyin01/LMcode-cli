//! Background task manager: spawns detached shell tasks, keeps a tail of
//! their output (memory ring + on-disk log at `<log_dir>/<id>/output.log`)
//! and exposes status/kill/read (mirrors
//! `packages/agent-core/src/tools/background/manager.ts`).

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWriteExt};

/// Bytes of output kept in memory per task (the full log lives on disk).
const TAIL_BYTES: usize = 64 * 1024;

/// Lifecycle state of a background task.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum BackgroundStatus {
    Running,
    Completed,
    Failed,
    Killed,
}

impl BackgroundStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Running => "running",
            Self::Completed => "completed",
            Self::Failed => "failed",
            Self::Killed => "killed",
        }
    }

    /// Whether the task will not change state anymore.
    pub fn is_terminal(self) -> bool {
        !matches!(self, Self::Running)
    }
}

/// Snapshot of one task for tools/UI.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackgroundTaskInfo {
    pub id: String,
    pub command: String,
    /// Short label recorded at spawn. Defaults to the command.
    pub description: String,
    pub status: BackgroundStatus,
    pub exit_code: Option<i32>,
    pub pid: Option<u32>,
    /// Set when `TaskStop` ends the task.
    pub stop_reason: Option<String>,
    pub output_path: String,
    /// Tail of the combined stdout/stderr.
    pub output: String,
    /// Unix epoch milliseconds, the same scale as `Date.now()`.
    pub started_at: u64,
    /// Unix epoch milliseconds, the same scale as `Date.now()`.
    pub finished_at: Option<u64>,
}

struct TaskEntry {
    command: String,
    description: String,
    status: BackgroundStatus,
    exit_code: Option<i32>,
    output: String,
    output_path: PathBuf,
    started_at: u64,
    finished_at: Option<u64>,
    pid: Option<u32>,
    stop_reason: Option<String>,
}

impl TaskEntry {
    fn info(&self, id: &str) -> BackgroundTaskInfo {
        BackgroundTaskInfo {
            id: id.to_string(),
            command: self.command.clone(),
            description: self.description.clone(),
            status: self.status,
            exit_code: self.exit_code,
            pid: self.pid,
            stop_reason: self.stop_reason.clone(),
            output_path: self.output_path.display().to_string(),
            output: self.output.clone(),
            started_at: self.started_at,
            finished_at: self.finished_at,
        }
    }
}

/// Owns detached shell tasks for the whole process.
pub struct BackgroundTaskManager {
    tasks: Mutex<HashMap<String, TaskEntry>>,
    log_dir: PathBuf,
}

impl BackgroundTaskManager {
    /// `log_dir` receives one `<id>/output.log` per task (the caller passes
    /// the LMcode home `tasks` directory).
    pub fn new(log_dir: PathBuf) -> Self {
        Self {
            tasks: Mutex::new(HashMap::new()),
            log_dir,
        }
    }

    /// Start `command` (through `cmd /C` on Windows, `sh -c` elsewhere) in
    /// the background and return its initial snapshot.
    pub fn spawn(
        self: &Arc<Self>,
        command: &str,
        cwd: &Path,
    ) -> Result<BackgroundTaskInfo, String> {
        let id = next_task_id();
        let dir = self.log_dir.join(&id);
        std::fs::create_dir_all(&dir)
            .map_err(|error| format!("failed to create task dir: {error}"))?;
        let output_path = dir.join("output.log");
        // Create/truncate the log up front; readers append to it below.
        std::fs::File::create(&output_path)
            .map_err(|error| format!("failed to create output log: {error}"))?;

        #[cfg(windows)]
        let mut cmd = {
            let mut cmd = tokio::process::Command::new("cmd");
            cmd.args(["/C", command]);
            cmd
        };
        #[cfg(not(windows))]
        let mut cmd = {
            let mut cmd = tokio::process::Command::new("sh");
            cmd.args(["-c", command]);
            cmd
        };
        cmd.current_dir(cwd)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped());
        let mut child = cmd
            .spawn()
            .map_err(|error| format!("failed to start command: {error}"))?;
        let pid = child.id();
        let stdout = child.stdout.take();
        let stderr = child.stderr.take();

        let entry = TaskEntry {
            command: command.to_string(),
            description: command.to_string(),
            status: BackgroundStatus::Running,
            exit_code: None,
            output: String::new(),
            output_path: output_path.clone(),
            started_at: now_millis(),
            finished_at: None,
            pid,
            stop_reason: None,
        };
        self.tasks
            .lock()
            .expect("background tasks lock")
            .insert(id.clone(), entry);
        let info = self.get(&id).expect("task was just inserted");

        // The waiter flips the status on exit; it must be started regardless
        // of reader setup so the task can never stay "running" forever.
        let manager = Arc::clone(self);
        let wait_id = id.clone();
        tokio::spawn(async move {
            let exit = child.wait().await;
            let mut tasks = manager.tasks.lock().expect("background tasks lock");
            if let Some(entry) = tasks.get_mut(&wait_id)
                && entry.status == BackgroundStatus::Running
            {
                match exit {
                    Ok(status) if status.success() => {
                        entry.status = BackgroundStatus::Completed;
                        entry.exit_code = status.code();
                    }
                    Ok(status) => {
                        entry.status = BackgroundStatus::Failed;
                        entry.exit_code = status.code();
                    }
                    Err(_) => {
                        entry.status = BackgroundStatus::Failed;
                    }
                }
                entry.finished_at = Some(now_millis());
            }
        });

        if let Some(stdout) = stdout {
            spawn_reader(Arc::clone(self), id.clone(), stdout, output_path.clone());
        }
        if let Some(stderr) = stderr {
            spawn_reader(Arc::clone(self), id, stderr, output_path);
        }

        Ok(info)
    }

    /// Snapshot of one task.
    pub fn get(&self, id: &str) -> Option<BackgroundTaskInfo> {
        self.tasks
            .lock()
            .expect("background tasks lock")
            .get(id)
            .map(|entry| entry.info(id))
    }

    /// All tasks, oldest first.
    pub fn list(&self) -> Vec<BackgroundTaskInfo> {
        let tasks = self.tasks.lock().expect("background tasks lock");
        let mut infos: Vec<BackgroundTaskInfo> =
            tasks.iter().map(|(id, entry)| entry.info(id)).collect();
        infos.sort_by(|a, b| {
            a.started_at
                .cmp(&b.started_at)
                .then_with(|| a.id.cmp(&b.id))
        });
        infos
    }

    /// Stop a running task and record why. Already-terminal tasks are an error;
    /// the caller reports their current state instead.
    pub fn stop(&self, id: &str, reason: &str) -> Result<BackgroundTaskInfo, String> {
        let mut tasks = self.tasks.lock().expect("background tasks lock");
        let entry = tasks
            .get_mut(id)
            .ok_or_else(|| format!("unknown background task `{id}`"))?;
        if entry.status != BackgroundStatus::Running {
            return Err(format!("task `{id}` is not running"));
        }
        if let Some(pid) = entry.pid {
            kill_process_tree(pid);
        }
        entry.status = BackgroundStatus::Killed;
        entry.stop_reason = Some(reason.to_string());
        entry.finished_at = Some(now_millis());
        Ok(entry.info(id))
    }

    /// Kill a running task (process tree included).
    pub fn kill(&self, id: &str) -> Result<(), String> {
        let mut tasks = self.tasks.lock().expect("background tasks lock");
        let entry = tasks
            .get_mut(id)
            .ok_or_else(|| format!("unknown background task `{id}`"))?;
        if entry.status != BackgroundStatus::Running {
            return Err(format!("task `{id}` is not running"));
        }
        if let Some(pid) = entry.pid {
            kill_process_tree(pid);
        }
        entry.status = BackgroundStatus::Killed;
        entry.finished_at = Some(now_millis());
        Ok(())
    }
}

/// Append a stream's bytes to the in-memory tail and the on-disk log. A
/// failed log open degrades to memory-only capture (never fails the task).
fn spawn_reader<R>(
    manager: Arc<BackgroundTaskManager>,
    id: String,
    mut stream: R,
    log_path: PathBuf,
) where
    R: AsyncRead + Unpin + Send + 'static,
{
    tokio::spawn(async move {
        let mut file = tokio::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&log_path)
            .await
            .ok();
        let mut buffer = [0u8; 4096];
        loop {
            let read = match stream.read(&mut buffer).await {
                Ok(0) | Err(_) => break,
                Ok(read) => read,
            };
            let chunk = String::from_utf8_lossy(&buffer[..read]).to_string();
            {
                let mut tasks = manager.tasks.lock().expect("background tasks lock");
                if let Some(entry) = tasks.get_mut(&id) {
                    entry.output.push_str(&chunk);
                    if entry.output.len() > TAIL_BYTES {
                        let excess = entry.output.len() - TAIL_BYTES;
                        let cut = (excess..entry.output.len())
                            .find(|index| entry.output.is_char_boundary(*index))
                            .unwrap_or(entry.output.len());
                        entry.output.drain(..cut);
                    }
                }
            }
            if let Some(file) = file.as_mut() {
                let _ = file.write_all(chunk.as_bytes()).await;
            }
        }
        if let Some(file) = file.as_mut() {
            let _ = file.flush().await;
        }
    });
}

/// Kill a process tree (best effort, platform specific).
fn kill_process_tree(pid: u32) {
    #[cfg(windows)]
    {
        let _ = std::process::Command::new("taskkill")
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status();
    }
    #[cfg(not(windows))]
    {
        let _ = std::process::Command::new("kill")
            .args(["-9", &format!("-{pid}")])
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status();
    }
}

fn next_task_id() -> String {
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0);
    let counter = COUNTER.fetch_add(1, Ordering::Relaxed);
    format!("task-{millis:x}-{counter:x}")
}

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("lmcode-bg-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// A command that keeps running for a while on the target platform.
    fn long_command() -> &'static str {
        if cfg!(windows) {
            "ping -n 30 127.0.0.1 >nul"
        } else {
            "sleep 30"
        }
    }

    async fn wait_terminal(manager: &BackgroundTaskManager, id: &str) -> BackgroundTaskInfo {
        for _ in 0..200 {
            let info = manager.get(id).expect("task exists");
            if info.status.is_terminal() {
                return info;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        panic!("task did not finish in time");
    }

    #[tokio::test]
    async fn spawn_captures_output_and_exit_status() {
        let dir = temp_dir("spawn");
        let manager = Arc::new(BackgroundTaskManager::new(dir.join("tasks")));
        let info = manager.spawn("echo hello-bg", &dir).unwrap();
        assert_eq!(info.status, BackgroundStatus::Running);
        let now_ms = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_millis() as u64;
        assert!(info.started_at >= 1_000_000_000_000);
        assert!(now_ms.abs_diff(info.started_at) < 60_000);

        let done = wait_terminal(&manager, &info.id).await;
        assert_eq!(done.status, BackgroundStatus::Completed);
        assert_eq!(done.exit_code, Some(0));
        assert!(done.output.contains("hello-bg"), "output: {}", done.output);
        // The full log is on disk.
        let log = std::fs::read_to_string(&done.output_path).unwrap();
        assert!(log.contains("hello-bg"), "log: {log}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn failing_commands_report_failed() {
        let dir = temp_dir("fail");
        let manager = Arc::new(BackgroundTaskManager::new(dir.join("tasks")));
        let info = manager.spawn("exit 3", &dir).unwrap();
        let done = wait_terminal(&manager, &info.id).await;
        assert_eq!(done.status, BackgroundStatus::Failed);
        assert_eq!(done.exit_code, Some(3));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn kill_marks_the_task_killed() {
        let dir = temp_dir("kill");
        let manager = Arc::new(BackgroundTaskManager::new(dir.join("tasks")));
        let info = manager.spawn(long_command(), &dir).unwrap();
        // Wait until the process is up and confirmed running before killing.
        let mut running = false;
        for _ in 0..40 {
            let current = manager.get(&info.id).unwrap();
            if current.status == BackgroundStatus::Running {
                running = true;
                break;
            }
            if current.status.is_terminal() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        assert!(running, "long-running task should still be running");
        manager.kill(&info.id).unwrap();
        let done = wait_terminal(&manager, &info.id).await;
        assert_eq!(done.status, BackgroundStatus::Killed);
        assert!(manager.kill(&info.id).is_err(), "second kill is rejected");
        assert!(manager.get("task-nope").is_none());
        assert!(manager.kill("task-nope").is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn list_is_ordered_oldest_first() {
        let dir = temp_dir("list");
        let manager = Arc::new(BackgroundTaskManager::new(dir.join("tasks")));
        let first = manager.spawn("echo one", &dir).unwrap();
        tokio::time::sleep(Duration::from_millis(10)).await;
        let second = manager.spawn("echo two", &dir).unwrap();
        let ids: Vec<String> = manager.list().into_iter().map(|info| info.id).collect();
        assert_eq!(ids, vec![first.id, second.id]);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
