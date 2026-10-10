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
        match self.exchange(method, params) {
            Ok(result) => result,
            Err(error) => panic!("{method} failed: {error}\nstderr:\n{}", self.stderr_now()),
        }
    }

    fn call_error(&mut self, method: &str, params: Value) -> Value {
        match self.exchange(method, params) {
            Ok(result) => panic!("{method} succeeded: {result}"),
            Err(error) => error,
        }
    }

    fn exchange(&mut self, method: &str, params: Value) -> Result<Value, Value> {
        self.next_id += 1;
        let id = self.next_id;
        self.send(&json!({"jsonrpc": "2.0", "id": id, "method": method, "params": params}));
        loop {
            let value = self.read();
            let matches = value.get("method").is_none()
                && value.get("id").and_then(Value::as_u64) == Some(id);
            if matches {
                if let Some(error) = value.get("error") {
                    return Err(error.clone());
                }
                return Ok(value.get("result").cloned().unwrap_or(Value::Null));
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
fn same_permission_during_a_turn_is_a_no_op() {
    let home = home("permission-busy");
    let cwd = home.join("work").to_string_lossy().to_string();
    let mut client = Client::launch(&home);
    client.call("initialize", json!({}));
    let started = client.call(
        "thread/start",
        json!({"cwd": cwd, "model": "script-bash", "permission": "manual"}),
    );
    assert_eq!(started["thread"]["permission"], "manual");
    client.call("turn/start", json!({"text": "run"}));
    let approval = client.take_method("item/commandExecution/requestApproval");

    let same = client.call("thread/setPermission", json!({"mode": "manual"}));
    assert_eq!(same["thread"]["permission"], "manual");
    let rejected = client.call_error("thread/setPermission", json!({"mode": "yolo"}));
    let message = rejected["message"].as_str().unwrap_or("");
    assert!(message.contains("a turn is already running"), "{rejected}");

    client.respond(&approval["id"], json!({"approved": false}));
    let completed = client.take_method("turn/completed");
    assert_eq!(completed["params"]["status"], "completed");
    let changed = client.call("thread/setPermission", json!({"mode": "yolo"}));
    assert_eq!(changed["thread"]["permission"], "yolo");

    let stderr = client.close();
    assert!(stderr.is_empty(), "{stderr}");
    let _ = std::fs::remove_dir_all(&home);
}

#[test]
fn a_second_thread_can_be_created_while_a_turn_is_running() {
    let home = home("second-thread");
    let cwd = home.join("work").to_string_lossy().to_string();
    let other = home.join("other");
    std::fs::create_dir_all(&other).expect("other");
    let other_cwd = other.to_string_lossy().to_string();
    let mut client = Client::launch(&home);
    client.call("initialize", json!({}));
    let first = client.call(
        "thread/start",
        json!({"cwd": cwd, "model": "script-bash", "permission": "manual"}),
    );
    let first_id = first["thread"]["id"].as_str().unwrap().to_string();
    client.call("turn/start", json!({"text": "run"}));
    let approval = client.take_method("item/commandExecution/requestApproval");

    let second = client.call(
        "thread/start",
        json!({"cwd": other_cwd, "model": "script", "permission": "auto"}),
    );
    let second_id = second["thread"]["id"].as_str().unwrap().to_string();
    assert_ne!(second_id, first_id);
    assert_eq!(second["activated"], true);
    assert_eq!(second["thread"]["permission"], "auto");
    assert_eq!(
        second["thread"]["cwd"].as_str().unwrap().replace('\\', "/"),
        other_cwd.replace('\\', "/")
    );
    let listed = client.call("thread/list", json!({}));
    let ids = listed["threads"]
        .as_array()
        .unwrap()
        .iter()
        .map(|row| row["id"].as_str().unwrap().to_string())
        .collect::<Vec<_>>();
    assert!(ids.contains(&first_id), "{ids:?}");
    assert!(ids.contains(&second_id), "{ids:?}");

    // The first turn is blocked on approval. Status and a real mode change on
    // that thread must not take its agent lock, and the second thread can
    // generate at the same time.
    let busy_status = client.call("thread/status", json!({"threadId": first_id}));
    assert_eq!(busy_status["contextTokens"], 0);
    let same = client.call(
        "thread/setPermission",
        json!({"threadId": first_id, "mode": "manual"}),
    );
    assert_eq!(same["thread"]["permission"], "manual");
    let rejected = client.call_error(
        "thread/setModel",
        json!({"threadId": first_id, "model": "script"}),
    );
    assert!(
        rejected["message"]
            .as_str()
            .unwrap_or("")
            .contains("a turn is already running"),
        "{rejected}"
    );
    let thinking = client.call(
        "thread/setThinking",
        json!({"threadId": second_id, "level": "low"}),
    );
    assert_eq!(thinking["thread"]["thinking"], "low");

    let second_turn = client.call(
        "turn/start",
        json!({"threadId": second_id, "text": "hello"}),
    );
    assert_eq!(second_turn["threadId"], second_id);
    assert_eq!(second_turn["status"], "started");
    let second_done = client.take_method("turn/completed");
    assert_eq!(second_done["params"]["threadId"], second_id);
    assert_eq!(second_done["params"]["status"], "completed");
    assert!(
        second_done["params"]["text"]
            .as_str()
            .unwrap_or("")
            .contains("hello"),
        "{second_done}"
    );

    client.respond(&approval["id"], json!({"approved": false}));
    let completed = client.take_method("turn/completed");
    assert_eq!(completed["params"]["threadId"], first_id);
    assert_eq!(completed["params"]["status"], "completed");
    let resumed = client.call(
        "thread/resume",
        json!({"cwd": other_cwd, "threadId": second_id}),
    );
    assert_eq!(resumed["thread"]["id"], second_id);
    assert_eq!(resumed["thread"]["permission"], "auto");

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

fn assert_millis_near_now(stamp: u64, label: &str) {
    let now_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("clock")
        .as_millis() as u64;
    assert!(
        stamp >= 1_000_000_000_000,
        "{label} {stamp} is not millisecond scale"
    );
    let delta = now_ms.abs_diff(stamp);
    assert!(delta < 60_000, "{label} {stamp} is {delta}ms from {now_ms}");
}

fn active_ids(client: &mut Client) -> Vec<String> {
    client.call("background/list", json!({"activeOnly": true}))["tasks"]
        .as_array()
        .expect("tasks")
        .iter()
        .filter_map(|task| task["id"].as_str().map(str::to_string))
        .collect()
}

fn listed_started_at(client: &mut Client, task_id: &str) -> u64 {
    let listed = client.call("background/list", json!({"activeOnly": false}));
    listed["tasks"]
        .as_array()
        .expect("tasks")
        .iter()
        .find(|task| task["id"] == task_id)
        .unwrap_or_else(|| panic!("task {task_id} missing: {listed}"))["startedAt"]
        .as_u64()
        .expect("startedAt")
}

fn assert_running_ping(client: &mut Client, task_id: &str) {
    let listed = client.call("background/list", json!({"activeOnly": true}));
    let task = listed["tasks"]
        .as_array()
        .expect("tasks")
        .iter()
        .find(|task| task["id"] == task_id)
        .unwrap_or_else(|| panic!("task {task_id} not running after resume: {listed}"));
    assert_eq!(task["status"], "running");
    let output = client.call("background/output", json!({"taskId": task_id}))["output"]
        .as_str()
        .unwrap_or("")
        .to_string();
    assert!(
        output.contains("127.0.0.1"),
        "task {task_id} output was {output:?}"
    );
}

fn wait_for_running_ping(client: &mut Client, except: Option<&str>) -> (String, u64) {
    let started_wait = Instant::now();
    while started_wait.elapsed() < Duration::from_secs(8) {
        let listed = client.call("background/list", json!({"activeOnly": false}));
        if let Some(task) = listed["tasks"]
            .as_array()
            .expect("tasks")
            .iter()
            .find(|task| {
                task["status"] == "running"
                    && task["command"].as_str().unwrap_or("").contains("127.0.0.1")
                    && task["id"].as_str() != except
            })
        {
            let task_id = task["id"].as_str().unwrap().to_string();
            let started_at = task["startedAt"].as_u64().expect("startedAt");
            let output = client.call("background/output", json!({"taskId": task_id}))["output"]
                .as_str()
                .unwrap_or("")
                .to_string();
            if output.contains("127.0.0.1") {
                return (task_id, started_at);
            }
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    panic!("running ping did not appear");
}

#[test]
fn skill_on_disk_activates_and_a_background_command_can_be_stopped() {
    let home = home("skills");
    let work = home.join("work");
    let skill_dir = work.join(".lmcode").join("skills").join("desk-probe");
    std::fs::create_dir_all(&skill_dir).expect("skill dir");
    std::fs::write(
        skill_dir.join("SKILL.md"),
        "---\nname: desk-probe\ndescription: probe the desktop skill list\n---\n\nFollow the desk-probe-body instructions.\n",
    )
    .expect("skill file");
    let cwd = work.to_string_lossy().to_string();

    let mut client = Client::launch(&home);
    client.call("initialize", json!({}));
    let started = client.call("thread/start", json!({"cwd": cwd, "model": "script"}));
    let thread_id = started["thread"]["id"].as_str().unwrap().to_string();

    let listed = client.call("skills/list", json!({}));
    let skills = listed["skills"].as_array().expect("skills");
    let skill = skills
        .iter()
        .find(|skill| skill["name"] == "desk-probe")
        .expect("desk-probe missing from skills/list");
    assert_eq!(skill["description"], "probe the desktop skill list");
    assert_eq!(skill["source"], "project");
    let listed_path = skill["path"].as_str().unwrap().replace('\\', "/");
    assert!(
        listed_path.ends_with(".lmcode/skills/desk-probe/SKILL.md"),
        "{listed_path}"
    );

    let activated = client.call(
        "skills/activate",
        json!({"name": "desk-probe", "args": "with-arg"}),
    );
    assert_eq!(activated["activated"], true);
    let completed = client.take_method("turn/completed");
    assert_eq!(completed["params"]["status"], "completed");
    let resumed = client.call("thread/resume", json!({"cwd": cwd, "threadId": thread_id}));
    let body = texts(&resumed["thread"]).join("\n");
    assert!(body.contains("desk-probe-body"), "{body}");
    assert!(body.contains("with-arg"), "{body}");

    client.call("thread/setModel", json!({"model": "script-bg"}));
    client.call("thread/setPermission", json!({"mode": "yolo"}));
    run_script_turn(&mut client, "start the background command");

    let mut output = String::new();
    let mut task_id = String::new();
    let started_wait = Instant::now();
    while started_wait.elapsed() < Duration::from_secs(8) {
        let listed = client.call("background/list", json!({"activeOnly": false}));
        let tasks = listed["tasks"].as_array().expect("tasks");
        if let Some(task) = tasks
            .iter()
            .find(|task| task["command"].as_str().unwrap_or("").contains("127.0.0.1"))
        {
            task_id = task["id"].as_str().unwrap().to_string();
            let read = client.call("background/output", json!({"taskId": task_id}));
            output = read["output"].as_str().unwrap_or("").to_string();
            if output.contains("127.0.0.1") {
                break;
            }
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    assert!(
        output.contains("127.0.0.1"),
        "task {task_id} output was {output:?}"
    );
    let started_at = listed_started_at(&mut client, &task_id);
    assert_millis_near_now(started_at, "startedAt");

    client.call("thread/resume", json!({"cwd": cwd, "threadId": thread_id}));
    assert_running_ping(&mut client, &task_id);

    let stopped = client.call(
        "background/stop",
        json!({"taskId": task_id, "reason": "test stop"}),
    );
    assert_eq!(stopped["task"]["status"], "killed");
    assert_eq!(stopped["task"]["stopReason"], "test stop");
    let finished_at = stopped["task"]["finishedAt"].as_u64().expect("finishedAt");
    assert!(finished_at >= started_at, "{finished_at} < {started_at}");
    assert_millis_near_now(finished_at, "finishedAt");
    assert!(
        !active_ids(&mut client).iter().any(|id| id == &task_id),
        "stopped task still listed as active"
    );

    client.call("thread/setModel", json!({"model": "script-bg"}));
    run_script_turn(&mut client, "start the second background command");
    let (second_id, second_started) = wait_for_running_ping(&mut client, Some(&task_id));
    assert_millis_near_now(second_started, "second startedAt");
    let other = home.join("other");
    std::fs::create_dir_all(&other).expect("other work");
    let other_cwd = other.to_string_lossy().to_string();
    client.call("thread/start", json!({"cwd": other_cwd, "model": "script"}));
    client.call("thread/resume", json!({"cwd": cwd, "threadId": thread_id}));
    assert_running_ping(&mut client, &second_id);
    let second_stopped = client.call(
        "background/stop",
        json!({"taskId": second_id, "reason": "second stop"}),
    );
    assert_eq!(second_stopped["task"]["status"], "killed");
    assert_eq!(second_stopped["task"]["stopReason"], "second stop");
    let second_finished = second_stopped["task"]["finishedAt"]
        .as_u64()
        .expect("second finishedAt");
    assert!(second_finished >= second_started);
    assert_millis_near_now(second_finished, "second finishedAt");
    assert!(
        !active_ids(&mut client).iter().any(|id| id == &second_id),
        "second task still listed as active"
    );

    let stderr = client.close();
    assert!(stderr.is_empty(), "app-server wrote to stderr:\n{stderr}");
    let _ = std::fs::remove_dir_all(&home);
}

fn zip_text(path: &str) -> String {
    let file = std::fs::File::open(path).expect("open zip");
    let mut archive = zip::ZipArchive::new(file).expect("zip");
    let mut combined = String::new();
    for index in 0..archive.len() {
        let mut entry = archive.by_index(index).expect("zip entry");
        let mut data = String::new();
        if std::io::Read::read_to_string(&mut entry, &mut data).is_ok() {
            combined.push_str(&data);
            combined.push('\n');
        }
    }
    combined
}

#[test]
fn export_status_and_image_parts_survive_resume() {
    let home = home("export");
    let mut config = std::fs::read_to_string(home.join("config.toml")).unwrap();
    config.push_str(
        "\n[models.script]\nprovider = \"local\"\nmodel = \"script\"\nmax_context_size = 8192\n",
    );
    std::fs::write(home.join("config.toml"), config).unwrap();
    let cwd = home.join("work").to_string_lossy().to_string();
    let prompt = "plain-user-sentence";
    let echoed = format!("script: {prompt}");
    let expected_tokens = (prompt.chars().count() + echoed.chars().count()) as u64;

    let mut first = Client::launch(&home);
    first.call("initialize", json!({}));
    let started = first.call("thread/start", json!({"cwd": cwd, "model": "script"}));
    let thread_id = started["thread"]["id"].as_str().unwrap().to_string();
    run_script_turn(&mut first, prompt);

    let status = first.call("thread/status", json!({}));
    assert_eq!(status["maxContextTokens"], 8192);
    assert_eq!(status["contextTokens"], expected_tokens);
    assert_eq!(status["contextUsage"], expected_tokens as f64 / 8192.0);

    let with_text = first.call(
        "turn/start",
        json!({
            "text": "see-the-picture",
            "images": ["data:image/png;base64,aaaa"]
        }),
    );
    assert_eq!(with_text["status"], "started");
    assert_eq!(
        first.take_method("turn/completed")["params"]["status"],
        "completed"
    );
    let image_only = first.call(
        "turn/start",
        json!({
            "text": "",
            "images": ["data:image/png;base64,bbbb"]
        }),
    );
    assert_eq!(image_only["status"], "started");
    assert_eq!(
        first.take_method("turn/completed")["params"]["status"],
        "completed"
    );

    let saved = first.call("thread/resume", json!({"cwd": cwd, "threadId": thread_id}));
    let rendered = saved["thread"]["messages"].to_string();
    assert!(rendered.contains("see-the-picture"), "{rendered}");
    assert!(
        rendered.contains("data:image/png;base64,aaaa"),
        "{rendered}"
    );
    assert!(
        rendered.contains("data:image/png;base64,bbbb"),
        "{rendered}"
    );
    assert!(rendered.contains("image_url"), "{rendered}");
    assert!(!rendered.contains("[image attachment]"), "{rendered}");

    let exported = first.call("session/export", json!({"cwd": cwd, "threadId": thread_id}));
    let zip_path = exported["zipPath"].as_str().unwrap();
    let archive = zip_text(zip_path);
    assert!(archive.contains(prompt), "{archive}");

    let stderr = first.close();
    assert!(stderr.is_empty(), "first launch wrote to stderr:\n{stderr}");

    let mut second = Client::launch(&home);
    second.call("initialize", json!({}));
    let resumed = second.call("thread/resume", json!({"cwd": cwd, "threadId": thread_id}));
    assert_eq!(resumed["thread"]["messages"], saved["thread"]["messages"]);
    let stderr = second.close();
    assert!(
        stderr.is_empty(),
        "second launch wrote to stderr:\n{stderr}"
    );
    let _ = std::fs::remove_dir_all(&home);
}

/// Every desktop session call on one home, then a second process resumes it.
#[test]
fn session_surface_survives_a_second_process() {
    let home = home("surface");
    let mut config = std::fs::read_to_string(home.join("config.toml")).unwrap();
    config.push_str(
        "\n[models.script]\nprovider = \"local\"\nmodel = \"script\"\nmax_context_size = 8192\n",
    );
    std::fs::write(home.join("config.toml"), config).unwrap();
    let work = home.join("work");
    let skill_dir = work.join(".lmcode").join("skills").join("gate-probe");
    std::fs::create_dir_all(&skill_dir).expect("skill dir");
    std::fs::write(
        skill_dir.join("SKILL.md"),
        "---\nname: gate-probe\ndescription: probe the combined session surface\n---\n\nFollow the gate-probe-body instructions.\n",
    )
    .expect("skill file");
    let tree = home.join("tree");
    std::fs::create_dir_all(&tree).expect("tree");
    let cwd = work.to_string_lossy().to_string();
    let tree_path = tree.to_string_lossy().to_string();
    let prompt = "plain-user-sentence";
    let drop = "beta-turn-remove-this-sentence";
    let echoed = format!("script: {prompt}");
    let expected_tokens = (prompt.chars().count() + echoed.chars().count()) as u64;
    let picture = "data:image/png;base64,gateA";
    let picture_only = "data:image/png;base64,gateB";

    let mut first = Client::launch(&home);
    first.call("initialize", json!({}));
    let started = first.call(
        "thread/start",
        json!({"cwd": cwd, "model": "script", "thinking": "low", "permission": "manual"}),
    );
    let thread_id = started["thread"]["id"].as_str().unwrap().to_string();
    assert_eq!(started["thread"]["model"], "script");
    assert_eq!(started["thread"]["thinking"], "low");
    assert_eq!(started["thread"]["permission"], "manual");
    assert_eq!(started["thread"]["planMode"], false);

    run_script_turn(&mut first, prompt);
    let status = first.call("thread/status", json!({}));
    assert_eq!(status["maxContextTokens"], 8192);
    assert_eq!(status["contextTokens"], expected_tokens);
    assert_eq!(status["contextUsage"], expected_tokens as f64 / 8192.0);

    let model = first.call("thread/setModel", json!({"model": "script"}));
    assert_eq!(model["thread"]["model"], "script");
    let thinking = first.call("thread/setThinking", json!({"level": "high"}));
    assert_eq!(thinking["thread"]["thinking"], "high");
    let permission = first.call("thread/setPermission", json!({"mode": "yolo"}));
    assert_eq!(permission["thread"]["permission"], "yolo");
    assert_eq!(permission["thread"]["model"], "script");
    assert_eq!(permission["thread"]["planMode"], false);

    run_script_turn(&mut first, drop);
    let undone = first.call("thread/undo", json!({"count": 1}));
    let undone_texts = texts(&undone["thread"]);
    assert!(
        undone_texts.iter().any(|text| text.contains(prompt)),
        "{undone_texts:?}"
    );
    assert!(
        undone_texts.iter().all(|text| !text.contains(drop)),
        "{undone_texts:?}"
    );
    let undone_len = undone["thread"]["messages"].as_array().unwrap().len();

    let exported = first.call("session/export", json!({"cwd": cwd, "threadId": thread_id}));
    let archive = zip_text(exported["zipPath"].as_str().unwrap());
    assert!(archive.contains(prompt), "{archive}");

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
    assert!(
        compacted_texts.iter().all(|text| !text.contains(prompt)),
        "{compacted_texts:?}"
    );

    let with_text = first.call(
        "turn/start",
        json!({"text": "see-the-picture", "images": [picture]}),
    );
    assert_eq!(with_text["status"], "started");
    assert_eq!(
        first.take_method("turn/completed")["params"]["status"],
        "completed"
    );
    let image_only = first.call("turn/start", json!({"text": "", "images": [picture_only]}));
    assert_eq!(image_only["status"], "started");
    assert_eq!(
        first.take_method("turn/completed")["params"]["status"],
        "completed"
    );

    let listed = first.call("skills/list", json!({}));
    let skill = listed["skills"]
        .as_array()
        .expect("skills")
        .iter()
        .find(|skill| skill["name"] == "gate-probe")
        .expect("gate-probe missing from skills/list");
    assert_eq!(skill["description"], "probe the combined session surface");
    assert_eq!(skill["source"], "project");
    let listed_path = skill["path"].as_str().unwrap().replace('\\', "/");
    assert!(
        listed_path.ends_with(".lmcode/skills/gate-probe/SKILL.md"),
        "{listed_path}"
    );
    let activated = first.call(
        "skills/activate",
        json!({"name": "gate-probe", "args": "with-arg"}),
    );
    assert_eq!(activated["activated"], true);
    assert_eq!(
        first.take_method("turn/completed")["params"]["status"],
        "completed"
    );

    let switched = first.call("thread/setModel", json!({"model": "script-bg"}));
    assert_eq!(switched["thread"]["model"], "script-bg");
    assert_eq!(switched["thread"]["thinking"], "high");
    assert_eq!(switched["thread"]["permission"], "yolo");
    run_script_turn(&mut first, "start the background command");
    let mut output = String::new();
    let mut task_id = String::new();
    let started_wait = Instant::now();
    while started_wait.elapsed() < Duration::from_secs(8) {
        let tasks = first.call("background/list", json!({"activeOnly": false}));
        if let Some(task) = tasks["tasks"]
            .as_array()
            .expect("tasks")
            .iter()
            .find(|task| task["command"].as_str().unwrap_or("").contains("127.0.0.1"))
        {
            task_id = task["id"].as_str().unwrap().to_string();
            output = first.call("background/output", json!({"taskId": task_id}))["output"]
                .as_str()
                .unwrap_or("")
                .to_string();
            if output.contains("127.0.0.1") {
                break;
            }
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    assert!(
        output.contains("127.0.0.1"),
        "task {task_id} output was {output:?}"
    );
    let stopped = first.call(
        "background/stop",
        json!({"taskId": task_id, "reason": "test stop"}),
    );
    assert_eq!(stopped["task"]["status"], "killed");
    let still_active = first.call("background/list", json!({"activeOnly": true}))["tasks"]
        .as_array()
        .unwrap()
        .iter()
        .any(|task| task["id"] == task_id);
    assert!(!still_active, "stopped task still listed as active");

    let planned = first.call("thread/setPlanMode", json!({"enabled": true}));
    assert_eq!(planned["thread"]["model"], "script-bg");
    assert_eq!(planned["thread"]["thinking"], "high");
    assert_eq!(planned["thread"]["permission"], "yolo");
    assert_eq!(planned["thread"]["planMode"], true);
    let history = planned["thread"]["messages"].to_string();
    assert!(history.contains("[Context compaction]"), "{history}");
    assert!(history.contains("see-the-picture"), "{history}");
    assert!(history.contains(picture), "{history}");
    assert!(history.contains(picture_only), "{history}");
    assert!(history.contains("image_url"), "{history}");
    assert!(history.contains("gate-probe-body"), "{history}");
    assert!(!history.contains("[image attachment]"), "{history}");
    assert!(!history.contains(drop), "{history}");
    assert!(!history.contains(prompt), "{history}");
    let final_messages = planned["thread"]["messages"].clone();

    let forked = first.call(
        "thread/fork",
        json!({
            "cwd": cwd,
            "threadId": thread_id,
            "targetCwd": tree_path,
            "metadata": {
                "desktopWorktree": {
                    "branch": "feature/gate",
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
        "feature/gate"
    );
    assert_eq!(forked["thread"]["desktopWorktree"]["path"], tree_path);
    assert_eq!(
        forked["thread"]["desktopWorktree"]["sourceSessionId"],
        thread_id
    );
    assert_eq!(forked["thread"]["model"], "script-bg");
    assert_eq!(forked["thread"]["thinking"], "high");
    assert_eq!(forked["thread"]["permission"], "yolo");
    assert_eq!(forked["thread"]["planMode"], true);
    assert_eq!(forked["thread"]["messages"], final_messages);

    let stderr = first.close();
    assert!(stderr.is_empty(), "first launch wrote to stderr:\n{stderr}");

    let mut second = Client::launch(&home);
    second.call("initialize", json!({}));
    let resumed = second.call("thread/resume", json!({"cwd": cwd, "threadId": thread_id}));
    assert_eq!(resumed["thread"]["model"], "script-bg");
    assert_eq!(resumed["thread"]["thinking"], "high");
    assert_eq!(resumed["thread"]["permission"], "yolo");
    assert_eq!(resumed["thread"]["planMode"], true);
    assert!(resumed["thread"]["desktopWorktree"].is_null());
    assert_eq!(resumed["thread"]["messages"], final_messages);

    let forked_again = second.call(
        "thread/resume",
        json!({"cwd": fork_cwd, "threadId": fork_id}),
    );
    assert_eq!(
        forked_again["thread"]["desktopWorktree"]["branch"],
        "feature/gate"
    );
    assert_eq!(forked_again["thread"]["desktopWorktree"]["path"], tree_path);
    assert_eq!(
        forked_again["thread"]["desktopWorktree"]["sourceSessionId"],
        thread_id
    );
    assert_eq!(forked_again["thread"]["model"], "script-bg");
    assert_eq!(forked_again["thread"]["thinking"], "high");
    assert_eq!(forked_again["thread"]["permission"], "yolo");
    assert_eq!(forked_again["thread"]["planMode"], true);
    assert_eq!(forked_again["thread"]["messages"], final_messages);

    let stderr = second.close();
    assert!(
        stderr.is_empty(),
        "second launch wrote to stderr:\n{stderr}"
    );
    let _ = std::fs::remove_dir_all(&home);
}
