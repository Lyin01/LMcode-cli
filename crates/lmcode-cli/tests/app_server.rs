//! Drive the real `lm app-server` process.
//!
//! Two launches against one home must agree on initialize, config, and memory
//! reads. The second launch reloads the first launch's messages, goal, and cron.

use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc::{self, Receiver};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde_json::{Value, json};

struct Client {
    child: Child,
    stdin: Option<ChildStdin>,
    lines: Receiver<String>,
    stderr: Receiver<String>,
    next_id: u64,
    notes: Vec<Value>,
}

impl Client {
    fn launch(home: &std::path::Path) -> Self {
        let mut child = Command::new(env!("CARGO_BIN_EXE_lm"))
            .arg("app-server")
            .env("LMCODE_HOME", home)
            .current_dir(home)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .expect("spawn lm app-server");
        let stdin = child.stdin.take();
        let stdout = child.stdout.take().expect("stdout");
        let stderr = child.stderr.take().expect("stderr");
        let (line_tx, lines) = mpsc::channel();
        std::thread::spawn(move || {
            let reader = BufReader::new(stdout);
            for line in reader.lines() {
                match line {
                    Ok(line) => {
                        if line_tx.send(line).is_err() {
                            break;
                        }
                    }
                    Err(_) => break,
                }
            }
        });
        let (err_tx, err_rx) = mpsc::channel();
        std::thread::spawn(move || {
            let mut reader = BufReader::new(stderr);
            let mut text = String::new();
            let _ = std::io::Read::read_to_string(&mut reader, &mut text);
            let _ = err_tx.send(text);
        });
        Self {
            child,
            stdin,
            lines,
            stderr: err_rx,
            next_id: 0,
            notes: Vec::new(),
        }
    }

    fn send(&mut self, value: &Value) {
        let stdin = self.stdin.as_mut().expect("stdin");
        writeln!(stdin, "{value}").expect("write request");
        stdin.flush().expect("flush request");
    }

    fn read(&mut self) -> Value {
        let line = self
            .lines
            .recv_timeout(Duration::from_secs(20))
            .unwrap_or_else(|_| panic!("app-server stalled\nstderr:\n{}", self.stderr_now()));
        serde_json::from_str(&line).unwrap_or_else(|error| {
            panic!(
                "stdout was not json ({error}): {line}\nstderr:\n{}",
                self.stderr_now()
            )
        })
    }

    fn call(&mut self, method: &str, params: Value) -> Value {
        self.next_id += 1;
        let id = self.next_id;
        self.send(&json!({"jsonrpc": "2.0", "id": id, "method": method, "params": params}));
        loop {
            let value = self.read();
            let matches = value.get("method").is_none()
                && value.get("id").and_then(Value::as_u64) == Some(id);
            if matches {
                if let Some(error) = value.get("error") {
                    panic!("{method} failed: {error}\nstderr:\n{}", self.stderr_now());
                }
                return value.get("result").cloned().unwrap_or(Value::Null);
            }
            self.notes.push(value);
        }
    }

    fn notify(&mut self, method: &str) {
        self.send(&json!({"jsonrpc": "2.0", "method": method}));
    }

    fn respond(&mut self, id: &Value, result: Value) {
        self.send(&json!({"jsonrpc": "2.0", "id": id, "result": result}));
    }

    fn take_method(&mut self, method: &str) -> Value {
        let started = Instant::now();
        loop {
            if let Some(index) = self
                .notes
                .iter()
                .position(|value| value.get("method").and_then(Value::as_str) == Some(method))
            {
                return self.notes.remove(index);
            }
            if started.elapsed() > Duration::from_secs(20) {
                panic!(
                    "timed out waiting for {method}\nstderr:\n{}",
                    self.stderr_now()
                );
            }
            let value = self.read();
            if value.get("method").and_then(Value::as_str) == Some(method) {
                return value;
            }
            self.notes.push(value);
        }
    }

    fn close(mut self) -> String {
        drop(self.stdin.take());
        let started = Instant::now();
        loop {
            if self.child.try_wait().ok().flatten().is_some() {
                break;
            }
            if started.elapsed() > Duration::from_secs(5) {
                let _ = self.child.kill();
                let _ = self.child.wait();
                break;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        self.stderr
            .recv_timeout(Duration::from_secs(2))
            .unwrap_or_default()
    }

    fn stderr_now(&self) -> String {
        String::new()
    }
}

impl Drop for Client {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

fn home(name: &str) -> PathBuf {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("clock")
        .as_nanos();
    let path = std::env::temp_dir().join(format!(
        "lmcode-app-server-{name}-{nanos}-{}",
        std::process::id()
    ));
    std::fs::create_dir_all(path.join("work")).expect("home");
    std::fs::write(
        path.join("config.toml"),
        "\
default_provider = \"local\"
default_model = \"script\"

[providers.local]
type = \"openai\"
api_key = \"test\"
base_url = \"http://127.0.0.1:9/v1\"
",
    )
    .expect("config");
    path
}

fn texts(thread: &Value) -> Vec<String> {
    thread["messages"]
        .as_array()
        .expect("messages")
        .iter()
        .map(|message| {
            message["content"]
                .as_array()
                .unwrap_or(&Vec::new())
                .iter()
                .filter_map(|part| part.get("text").and_then(Value::as_str))
                .collect::<String>()
        })
        .collect()
}

#[test]
fn two_launches_agree_and_the_second_reloads_messages_goal_and_cron() {
    let home = home("restore");
    let work = home.join("work");
    let cwd = work.to_string_lossy().to_string();
    let config_text = std::fs::read_to_string(home.join("config.toml")).unwrap();

    let mut first = Client::launch(&home);
    let init = first.call("initialize", json!({}));
    first.notify("initialized");
    assert_eq!(init["protocolVersion"], 1);
    assert_eq!(init["capabilities"]["computerUse"], true);
    assert_eq!(init["capabilities"]["approval"], true);
    let config = first.call("config/read", json!({}));
    assert_eq!(config["text"], config_text);
    let memories = first.call("memory/list", json!({}));
    assert_eq!(memories["memories"].as_array().unwrap().len(), 0);
    let searched = first.call("memory/search", json!({"query": "rust"}));
    assert_eq!(searched["memories"].as_array().unwrap().len(), 0);
    assert_eq!(
        first.call("memory/delete", json!({"id": "missing"}))["deleted"],
        false
    );
    assert_eq!(
        first.call("mcp/list", json!({}))["servers"]
            .as_array()
            .unwrap()
            .len(),
        0
    );
    let added = first.call(
        "mcp/add",
        json!({"name": "demo", "config": {"command": "demo-mcp"}}),
    );
    assert_eq!(added["name"], "demo");
    assert_eq!(
        first.call("mcp/list", json!({}))["servers"][0]["name"],
        "demo"
    );
    assert_eq!(
        first.call("mcp/reconnect", json!({"name": "demo"}))["connected"],
        false
    );
    assert_eq!(
        first.call("mcp/remove", json!({"name": "demo"}))["removed"],
        true
    );

    let started = first.call("thread/start", json!({"cwd": cwd, "model": "script"}));
    let thread_id = started["thread"]["id"].as_str().unwrap().to_string();
    assert_eq!(started["thread"]["messages"].as_array().unwrap().len(), 0);
    let status = first.call("computerUse/status", json!({}));
    assert_eq!(status["phase"], "idle");
    assert_eq!(status["providerId"], "cua-driver-mcp");

    let goal = first.call("goal/create", json!({"objective": "ship the rust core"}));
    assert_eq!(goal["goal"]["objective"], "ship the rust core");
    assert_eq!(goal["goal"]["status"], "active");
    let task = first.call(
        "cron/create",
        json!({"cron": "0 0 * * *", "prompt": "ping the build", "recurring": true}),
    );
    assert_eq!(task["task"]["prompt"], "ping the build");

    let turn = first.call(
        "turn/start",
        json!({"threadId": thread_id, "text": "hello"}),
    );
    assert_eq!(turn["status"], "started");
    let completed = first.take_method("turn/completed");
    assert_eq!(completed["params"]["status"], "completed");
    assert_eq!(completed["params"]["text"], "script: hello");

    let renamed = first.call(
        "thread/rename",
        json!({"cwd": cwd, "threadId": thread_id, "title": "kept"}),
    );
    assert_eq!(renamed["thread"]["title"], "kept");
    let forked = first.call("thread/fork", json!({"cwd": cwd, "threadId": thread_id}));
    let fork_id = forked["thread"]["id"].as_str().unwrap().to_string();
    assert_eq!(forked["thread"]["forkedFrom"], thread_id);
    assert_eq!(forked["goal"]["objective"], "ship the rust core");
    assert_eq!(forked["tasks"][0]["prompt"], "ping the build");
    assert!(texts(&forked["thread"]).iter().any(|text| text == "hello"));
    assert!(
        texts(&forked["thread"])
            .iter()
            .any(|text| text == "script: hello")
    );

    let stderr = first.close();
    assert!(stderr.is_empty(), "first launch wrote to stderr:\n{stderr}");

    let mut second = Client::launch(&home);
    let init_again = second.call("initialize", json!({}));
    assert_eq!(init_again, init);
    let config_again = second.call("config/read", json!({}));
    assert_eq!(config_again["text"], config["text"]);
    let memories_again = second.call("memory/list", json!({}));
    assert_eq!(memories_again, memories);
    assert_eq!(
        second.call("computerUse/status", json!({}))["phase"],
        "idle"
    );

    let resumed = second.call("thread/resume", json!({"cwd": cwd, "threadId": thread_id}));
    assert_eq!(resumed["thread"]["title"], "kept");
    let restored = texts(&resumed["thread"]);
    assert!(restored.iter().any(|text| text == "hello"), "{restored:?}");
    assert!(
        restored.iter().any(|text| text == "script: hello"),
        "{restored:?}"
    );
    let goal_again = second.call("goal/get", json!({}));
    assert_eq!(goal_again["goal"]["objective"], "ship the rust core");
    assert_eq!(goal_again["goal"]["status"], "active");
    let tasks = second.call("cron/list", json!({}));
    assert_eq!(tasks["tasks"][0]["prompt"], "ping the build");
    assert_eq!(tasks["tasks"][0]["cron"], "0 0 * * *");

    let forked_again = second.call("thread/resume", json!({"cwd": cwd, "threadId": fork_id}));
    assert_eq!(forked_again["thread"]["forkedFrom"], thread_id);
    assert_eq!(
        second.call("goal/get", json!({}))["goal"]["objective"],
        "ship the rust core"
    );
    let listed = second.call("thread/list", json!({"cwd": cwd}));
    assert_eq!(listed["threads"].as_array().unwrap().len(), 2);
    assert_eq!(
        second.call("thread/delete", json!({"cwd": cwd, "threadId": fork_id}))["deleted"],
        true
    );
    let listed = second.call("thread/list", json!({"cwd": cwd}));
    assert_eq!(listed["threads"].as_array().unwrap().len(), 1);
    assert_eq!(listed["threads"][0]["id"], thread_id);

    let stderr = second.close();
    assert!(
        stderr.is_empty(),
        "second launch wrote to stderr:\n{stderr}"
    );
    let _ = std::fs::remove_dir_all(&home);
}

#[test]
fn due_cron_fires_into_a_turn_and_notifies() {
    let home = home("cron-fire");
    let cwd = home.join("work").to_string_lossy().to_string();
    let mut client = Client::launch(&home);
    client.call("initialize", json!({}));
    let started = client.call("thread/start", json!({"cwd": cwd, "model": "script"}));
    let thread_id = started["thread"]["id"].as_str().unwrap().to_string();
    let session_dir = PathBuf::from(started["thread"]["sessionDir"].as_str().unwrap());
    let cron_dir = session_dir.join("cron");
    std::fs::create_dir_all(&cron_dir).expect("cron dir");
    let created_at = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("clock")
        .as_millis() as u64
        - 10 * 60_000;
    std::fs::write(
        cron_dir.join("duejob01.json"),
        serde_json::to_string(&json!({
            "id": "duejob01",
            "cron": "* * * * *",
            "prompt": "ping the build",
            "createdAt": created_at,
            "recurring": true,
        }))
        .unwrap(),
    )
    .expect("cron file");

    // Resume reloads the on-disk job. The server tick then delivers it.
    client.call("thread/resume", json!({"cwd": cwd, "threadId": thread_id}));
    let fired = client.take_method("cron/fired");
    assert_eq!(fired["params"]["threadId"], thread_id);
    assert_eq!(fired["params"]["prompt"], "ping the build");
    assert_eq!(fired["params"]["origin"]["kind"], "cron_job");
    assert_eq!(fired["params"]["origin"]["jobId"], "duejob01");
    assert_eq!(fired["params"]["origin"]["cron"], "* * * * *");
    assert_eq!(fired["params"]["origin"]["recurring"], true);
    assert_eq!(fired["params"]["origin"]["coalescedCount"], 1);
    assert_eq!(fired["params"]["origin"]["stale"], false);
    let completed = client.take_method("turn/completed");
    assert_eq!(completed["params"]["status"], "completed");
    assert_eq!(
        completed["params"]["text"],
        "script: A scheduled task has fired — handle it."
    );
    let tasks = client.call("cron/list", json!({}));
    assert_eq!(tasks["tasks"][0]["id"], "duejob01");
    assert!(tasks["tasks"][0]["lastFiredAt"].as_u64().is_some());
    let stderr = client.close();
    assert!(stderr.is_empty(), "cron fire wrote to stderr:\n{stderr}");
    let _ = std::fs::remove_dir_all(&home);
}

#[test]
fn list_all_sessions_and_config_patch_round_trip() {
    let home = home("panels");
    let cwd = home.join("work").to_string_lossy().to_string();
    let other = home.join("other");
    std::fs::create_dir_all(&other).expect("other workdir");
    let other_cwd = other.to_string_lossy().to_string();

    let mut client = Client::launch(&home);
    client.call("initialize", json!({}));
    let started = client.call("thread/start", json!({"cwd": cwd, "model": "script"}));
    let first_id = started["thread"]["id"].as_str().unwrap().to_string();
    assert!(
        started["thread"]["sessionDir"]
            .as_str()
            .unwrap()
            .contains(&first_id)
    );
    client.call("thread/start", json!({"cwd": other_cwd, "model": "script"}));

    let all = client.call("thread/list", json!({}));
    assert_eq!(all["threads"].as_array().unwrap().len(), 2);
    let scoped = client.call("thread/list", json!({"cwd": cwd}));
    assert_eq!(scoped["threads"].as_array().unwrap().len(), 1);
    assert_eq!(scoped["threads"][0]["id"], first_id);

    let config = client.call("config/get", json!({}));
    assert_eq!(config["defaultModel"], "script");
    assert_eq!(config["providers"]["local"]["apiKey"], "test");
    assert_eq!(
        config["providers"]["local"]["baseUrl"],
        "http://127.0.0.1:9/v1"
    );
    let patched = client.call(
        "config/patch",
        json!({
            "patch": {
                "anchoredBootstrap": {"enabled": true, "providers": ["deepseek"]},
                "providers": {"extra": {"type": "openai", "apiKey": "added"}}
            }
        }),
    );
    assert_eq!(patched["anchoredBootstrap"]["enabled"], true);
    assert_eq!(patched["providers"]["local"]["apiKey"], "test");
    assert_eq!(patched["providers"]["extra"]["apiKey"], "added");
    let removed = client.call(
        "config/patch",
        json!({"patch": {"providers": {"extra": null}}}),
    );
    assert!(removed["providers"].get("extra").is_none());
    assert_eq!(removed["providers"]["local"]["apiKey"], "test");
    assert_eq!(removed["anchoredBootstrap"]["providers"][0], "deepseek");

    let text = client.call("config/read", json!({}))["text"]
        .as_str()
        .unwrap()
        .to_string();
    assert!(text.contains("anchoredBootstrap"), "{text}");
    assert!(text.contains("api_key = \"test\""), "{text}");

    let stderr = client.close();
    assert!(stderr.is_empty(), "panel launch wrote to stderr:\n{stderr}");
    let _ = std::fs::remove_dir_all(&home);
}

#[test]
fn approval_question_steer_and_interrupt_round_trip() {
    let home = home("turn");
    let cwd = home.join("work").to_string_lossy().to_string();
    let mut client = Client::launch(&home);
    client.call("initialize", json!({}));

    client.call("thread/start", json!({"cwd": cwd, "model": "script-bash"}));
    client.call("turn/start", json!({"text": "run"}));
    let approval = client.take_method("item/commandExecution/requestApproval");
    assert_eq!(approval["params"]["tool"], "Bash");
    client.respond(&approval["id"], json!({"approved": false}));
    let completed = client.take_method("turn/completed");
    assert_eq!(completed["params"]["status"], "completed");
    assert!(
        client.notes.iter().any(|note| {
            note["method"] == "item/tool/completed" && note["params"]["ok"] == false
        }),
        "{:?}",
        client.notes
    );

    client.call("thread/start", json!({"cwd": cwd, "model": "script-ask"}));
    client.call("turn/start", json!({"text": "ask"}));
    let question = client.take_method("item/tool/requestUserInput");
    assert_eq!(question["params"]["questions"][0]["question"], "Which?");
    client.respond(&question["id"], json!({"answers": {"A": true}}));
    let completed = client.take_method("turn/completed");
    assert_eq!(completed["params"]["status"], "completed");
    assert!(
        completed["params"]["text"]
            .as_str()
            .unwrap()
            .contains("script:")
    );

    client.call("thread/start", json!({"cwd": cwd, "model": "script-pause"}));
    let steer_thread = client.call("turn/start", json!({"text": "hello"}));
    client.take_method("turn/started");
    let steered = client.call("turn/steer", json!({"text": "extra"}));
    assert_eq!(steered["accepted"], true);
    let completed = client.take_method("turn/completed");
    let text = completed["params"]["text"].as_str().unwrap();
    assert!(text.contains("script: hello"), "{text}");
    assert!(text.contains("script: extra"), "{text}");
    let _ = steer_thread;

    client.call("thread/start", json!({"cwd": cwd, "model": "script-pause"}));
    let paused = client.call("turn/start", json!({"text": "please-stop"}));
    let paused_id = paused["threadId"].as_str().unwrap().to_string();
    client.take_method("turn/started");
    let interrupted = client.call("turn/interrupt", json!({}));
    assert_eq!(interrupted["interrupted"], true);
    let completed = client.take_method("turn/completed");
    assert_eq!(completed["params"]["status"], "interrupted");
    let resumed = client.call("thread/resume", json!({"cwd": cwd, "threadId": paused_id}));
    let restored = texts(&resumed["thread"]);
    assert!(
        restored.iter().all(|text| !text.contains("please-stop")),
        "{restored:?}"
    );

    let idle = client.call("turn/steer", json!({"text": "too late"}));
    assert_eq!(idle["accepted"], false);
    let idle = client.call("turn/interrupt", json!({}));
    assert_eq!(idle["interrupted"], false);

    let stderr = client.close();
    assert!(stderr.is_empty(), "turn launch wrote to stderr:\n{stderr}");
    let _ = std::fs::remove_dir_all(&home);
}

#[test]
fn enabling_computer_use_reports_that_the_driver_is_not_launched() {
    let home = home("computer");
    let cwd = home.join("work").to_string_lossy().to_string();
    let mut client = Client::launch(&home);
    client.call("initialize", json!({}));
    client.call("thread/start", json!({"cwd": cwd, "model": "script"}));
    let failed = client.call("computerUse/setEnabled", json!({"enabled": true}));
    assert_eq!(failed["phase"], "failed");
    assert!(
        failed["error"].as_str().unwrap().contains("not launched"),
        "{failed}"
    );
    let idle = client.call("computerUse/setEnabled", json!({"enabled": false}));
    assert_eq!(idle["phase"], "idle");
    assert!(idle.get("error").is_none(), "{idle}");
    let stderr = client.close();
    assert!(stderr.is_empty(), "{stderr}");
    let _ = std::fs::remove_dir_all(&home);
}

#[test]
fn session_controls_and_worktree_survive_a_second_process() {
    let home = home("controls");
    let cwd = home.join("work").to_string_lossy().to_string();
    let tree = home.join("tree");
    std::fs::create_dir_all(&tree).expect("tree");
    let tree_path = tree.to_string_lossy().to_string();

    let mut first = Client::launch(&home);
    first.call("initialize", json!({}));
    let started = first.call(
        "thread/start",
        json!({"cwd": cwd, "model": "script", "thinking": "low", "permission": "auto"}),
    );
    let thread_id = started["thread"]["id"].as_str().unwrap().to_string();
    assert_eq!(started["thread"]["model"], "script");
    assert_eq!(started["thread"]["thinking"], "low");
    assert_eq!(started["thread"]["permission"], "auto");
    assert_eq!(started["thread"]["planMode"], false);
    assert!(started["thread"]["desktopWorktree"].is_null());

    let model = first.call("thread/setModel", json!({"model": "script-ask"}));
    assert_eq!(model["thread"]["model"], "script-ask");
    assert_eq!(model["thread"]["thinking"], "low");
    let thinking = first.call("thread/setThinking", json!({"level": "high"}));
    assert_eq!(thinking["thread"]["thinking"], "high");
    let permission = first.call("thread/setPermission", json!({"mode": "yolo"}));
    assert_eq!(permission["thread"]["permission"], "yolo");
    let plan = first.call("thread/setPlanMode", json!({"enabled": true}));
    assert_eq!(plan["thread"]["planMode"], true);
    assert_eq!(plan["thread"]["model"], "script-ask");
    assert_eq!(plan["thread"]["thinking"], "high");
    assert_eq!(plan["thread"]["permission"], "yolo");

    let forked = first.call(
        "thread/fork",
        json!({
            "cwd": cwd,
            "threadId": thread_id,
            "targetCwd": tree_path,
            "metadata": {
                "desktopWorktree": {
                    "branch": "feature/rust",
                    "path": tree_path,
                    "sourceSessionId": thread_id,
                }
            }
        }),
    );
    let fork_id = forked["thread"]["id"].as_str().unwrap().to_string();
    let fork_cwd = forked["thread"]["cwd"].as_str().unwrap().to_string();
    assert_eq!(
        forked["thread"]["desktopWorktree"]["branch"],
        "feature/rust"
    );
    assert_eq!(forked["thread"]["desktopWorktree"]["path"], tree_path);
    assert_eq!(
        forked["thread"]["desktopWorktree"]["sourceSessionId"],
        thread_id
    );
    assert_eq!(forked["thread"]["model"], "script-ask");
    assert_eq!(forked["thread"]["thinking"], "high");
    assert_eq!(forked["thread"]["permission"], "yolo");
    assert_eq!(forked["thread"]["planMode"], true);
    assert!(forked["thread"]["desktopWorktree"]["branch"].is_string());

    let stderr = first.close();
    assert!(stderr.is_empty(), "first launch wrote to stderr:\n{stderr}");

    let mut second = Client::launch(&home);
    second.call("initialize", json!({}));
    let listed = second.call("thread/list", json!({}));
    let rows = listed["threads"].as_array().expect("threads");
    let source_row = rows
        .iter()
        .find(|row| row["id"] == thread_id)
        .expect("source session");
    assert_eq!(source_row["model"], "script-ask");
    assert_eq!(source_row["thinking"], "high");
    assert_eq!(source_row["permission"], "yolo");
    assert_eq!(source_row["planMode"], true);
    assert!(source_row["desktopWorktree"].is_null());
    let fork_row = rows
        .iter()
        .find(|row| row["id"] == fork_id)
        .expect("forked session");
    assert_eq!(fork_row["desktopWorktree"]["branch"], "feature/rust");
    assert_eq!(fork_row["desktopWorktree"]["path"], tree_path);
    assert_eq!(fork_row["desktopWorktree"]["sourceSessionId"], thread_id);

    let resumed = second.call("thread/resume", json!({"cwd": cwd, "threadId": thread_id}));
    assert_eq!(resumed["thread"]["model"], "script-ask");
    assert_eq!(resumed["thread"]["thinking"], "high");
    assert_eq!(resumed["thread"]["permission"], "yolo");
    assert_eq!(resumed["thread"]["planMode"], true);
    assert!(resumed["thread"]["desktopWorktree"].is_null());

    let forked_again = second.call(
        "thread/resume",
        json!({"cwd": fork_cwd, "threadId": fork_id}),
    );
    assert_eq!(
        forked_again["thread"]["desktopWorktree"]["branch"],
        "feature/rust"
    );
    assert_eq!(forked_again["thread"]["desktopWorktree"]["path"], tree_path);
    assert_eq!(
        forked_again["thread"]["desktopWorktree"]["sourceSessionId"],
        thread_id
    );
    assert_eq!(forked_again["thread"]["model"], "script-ask");
    assert_eq!(forked_again["thread"]["thinking"], "high");
    assert_eq!(forked_again["thread"]["permission"], "yolo");
    assert_eq!(forked_again["thread"]["planMode"], true);

    let stderr = second.close();
    assert!(
        stderr.is_empty(),
        "second launch wrote to stderr:\n{stderr}"
    );
    let _ = std::fs::remove_dir_all(&home);
}

fn run_script_turn(client: &mut Client, text: &str) {
    let started = client.call("turn/start", json!({"text": text}));
    assert_eq!(started["status"], "started");
    let completed = client.take_method("turn/completed");
    assert_eq!(completed["params"]["status"], "completed");
}

#[test]
fn undo_and_compact_shorten_history_for_the_next_process() {
    let home = home("history");
    let cwd = home.join("work").to_string_lossy().to_string();
    let keep = "alpha-turn-keep-this-sentence";
    let drop = "beta-turn-remove-this-sentence";

    let mut first = Client::launch(&home);
    first.call("initialize", json!({}));
    let started = first.call("thread/start", json!({"cwd": cwd, "model": "script"}));
    let thread_id = started["thread"]["id"].as_str().unwrap().to_string();
    run_script_turn(&mut first, keep);
    run_script_turn(&mut first, drop);

    let before = first.call("thread/resume", json!({"cwd": cwd, "threadId": thread_id}));
    let before_len = before["thread"]["messages"].as_array().unwrap().len();
    assert!(before_len >= 4, "{before_len}");

    let undone = first.call("thread/undo", json!({"count": 1}));
    let undone_texts = texts(&undone["thread"]);
    assert!(
        undone_texts.iter().any(|text| text.contains(keep)),
        "{undone_texts:?}"
    );
    assert!(
        undone_texts.iter().all(|text| !text.contains(drop)),
        "{undone_texts:?}"
    );
    let undone_len = undone["thread"]["messages"].as_array().unwrap().len();
    assert!(undone_len < before_len, "{undone_len} vs {before_len}");

    let compacted = first.call("thread/compact", json!({}));
    assert!(
        first.notes.iter().any(|value| {
            value.get("method").and_then(Value::as_str) == Some("compaction/completed")
        }),
        "missing compaction/completed"
    );
    let compacted_len = compacted["thread"]["messages"].as_array().unwrap().len();
    assert!(
        compacted_len < undone_len,
        "{compacted_len} vs {undone_len}"
    );
    let compacted_texts = texts(&compacted["thread"]);
    assert!(
        compacted_texts
            .iter()
            .any(|text| text.contains("[Context compaction]")),
        "{compacted_texts:?}"
    );

    let stderr = first.close();
    assert!(stderr.is_empty(), "first launch wrote to stderr:\n{stderr}");

    let mut second = Client::launch(&home);
    second.call("initialize", json!({}));
    let resumed = second.call("thread/resume", json!({"cwd": cwd, "threadId": thread_id}));
    assert_eq!(
        resumed["thread"]["messages"],
        compacted["thread"]["messages"]
    );
    let stderr = second.close();
    assert!(
        stderr.is_empty(),
        "second launch wrote to stderr:\n{stderr}"
    );
    let _ = std::fs::remove_dir_all(&home);
}
