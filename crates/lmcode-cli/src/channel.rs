//! `lm channel setup` — cc-connect platform configuration.
//!
//! Mirrors `apps/lmcode/src/cli/channel-setup.ts`: checks cc-connect is
//! installed, lets the user pick a platform, generates (or appends to)
//! `~/.cc-connect/config.toml`, and prints the next steps.

use std::io::{IsTerminal, Write};
use std::path::PathBuf;
use std::process::Command;

struct PlatformDef {
    r#type: &'static str,
    name: &'static str,
    desc: &'static str,
    setup_cmd: &'static str,
    note: Option<&'static str>,
}

const PLATFORMS: &[PlatformDef] = &[
    PlatformDef {
        r#type: "weixin",
        name: "微信",
        desc: "个人微信，ilink bot 协议，扫码登录",
        setup_cmd: "weixin setup",
        note: None,
    },
    PlatformDef {
        r#type: "feishu",
        name: "飞书",
        desc: "飞书/Lark 企业通讯，无需公网 IP",
        setup_cmd: "feishu setup",
        note: None,
    },
    PlatformDef {
        r#type: "telegram",
        name: "Telegram",
        desc: "Telegram bot，需提前在 @BotFather 创建",
        setup_cmd: "telegram setup",
        note: None,
    },
    PlatformDef {
        r#type: "dingtalk",
        name: "钉钉",
        desc: "钉钉企业通讯",
        setup_cmd: "dingtalk setup",
        note: None,
    },
    PlatformDef {
        r#type: "discord",
        name: "Discord",
        desc: "Discord 社区平台",
        setup_cmd: "discord setup",
        note: None,
    },
    PlatformDef {
        r#type: "slack",
        name: "Slack",
        desc: "Slack 企业通讯",
        setup_cmd: "slack setup",
        note: None,
    },
    PlatformDef {
        r#type: "qq",
        name: "QQ",
        desc: "QQ via NapCat/OneBot",
        setup_cmd: "qq setup",
        note: Some("需要先安装 NapCat 或 OneBot 桥接"),
    },
    PlatformDef {
        r#type: "qqbot",
        name: "QQ Bot (官方)",
        desc: "QQ 官方 Bot API",
        setup_cmd: "qqbot setup",
        note: None,
    },
    PlatformDef {
        r#type: "wecom",
        name: "企业微信",
        desc: "WeChat Work，需公网 IP",
        setup_cmd: "wecom setup",
        note: Some("需要公网 URL 或 ngrok"),
    },
    PlatformDef {
        r#type: "weibo",
        name: "微博",
        desc: "微博消息通道",
        setup_cmd: "weibo setup",
        note: None,
    },
    PlatformDef {
        r#type: "wps-xiezuo",
        name: "WPS 协作",
        desc: "WPS 协同办公",
        setup_cmd: "wps-xiezuo setup",
        note: None,
    },
];

/// Run `lm channel setup`; returns the process exit code.
pub fn run_channel_setup() -> i32 {
    println!();
    println!("🧩  cc-connect 快速通道配置");
    println!("{}", "━".repeat(50));
    println!();

    // Step 1: check cc-connect.
    match cc_connect_version() {
        Some(version) => println!("  ✔ cc-connect 已安装 ({version})"),
        None => {
            println!("  ✖ cc-connect 未安装");
            println!();
            println!("  请先安装 cc-connect：");
            println!("    npm install -g cc-connect");
            println!();
            println!("  安装完成后重新运行：");
            println!("    lm channel setup");
            println!();
            return 1;
        }
    }
    println!();

    if !std::io::stdin().is_terminal() {
        println!("  ⚠ 需要交互式终端来选择平台；请直接运行 `lm channel setup`。");
        return 1;
    }

    // Step 2: select a platform.
    println!("  选择你要连接的平台：");
    println!();
    for (index, platform) in PLATFORMS.iter().enumerate() {
        println!(
            "  {:>2}. {:<14} — {}",
            index + 1,
            platform.name,
            platform.desc
        );
    }
    println!();
    print!("  输入编号 (1-{}): ", PLATFORMS.len());
    let _ = std::io::stdout().flush();
    let mut answer = String::new();
    if std::io::stdin().read_line(&mut answer).is_err() {
        return 1;
    }
    let index: usize = match answer.trim().parse::<usize>() {
        Ok(value) if value >= 1 && value <= PLATFORMS.len() => value - 1,
        _ => {
            println!();
            println!(
                "  ✖ 无效选择: \"{}\"，请输入 1-{}",
                answer.trim(),
                PLATFORMS.len()
            );
            println!();
            return 1;
        }
    };
    let platform = &PLATFORMS[index];
    println!();
    println!("  ✔ 已选择: {}", platform.name);
    if let Some(note) = platform.note {
        println!("  ℹ {note}");
    }
    println!();

    // Step 3: detect the lm binary path.
    let cli_path = detect_lm_path();
    println!("  LMcode 路径: {cli_path}");
    println!();

    // Step 4: generate (or append to) the cc-connect config.
    let config_path = cc_connect_config_path();
    if let Some(parent) = config_path.parent()
        && !parent.exists()
        && let Err(error) = std::fs::create_dir_all(parent)
    {
        eprintln!("error: cannot create {}: {error}", parent.display());
        return 1;
    }
    let config_content = generate_config(&cli_path, platform.r#type);
    if config_path.exists() {
        let existing = std::fs::read_to_string(&config_path).unwrap_or_default();
        if existing.contains(&format!("type = \"{}\"", platform.r#type)) {
            println!("  ⚠ {} 已配置过，跳过写入", platform.name);
        } else {
            let append = format!("\n[[projects.platforms]]\ntype = \"{}\"\n", platform.r#type);
            if let Err(error) = std::fs::write(&config_path, format!("{existing}{append}")) {
                eprintln!("error: cannot write {}: {error}", config_path.display());
                return 1;
            }
            println!("  ✔ 已追加 {} 到现有配置", platform.name);
        }
        println!();
    } else {
        if let Err(error) = std::fs::write(&config_path, config_content) {
            eprintln!("error: cannot write {}: {error}", config_path.display());
            return 1;
        }
        println!("  ✔ 配置已写入 {}", config_path.display());
        println!();
    }

    // Step 5: next steps.
    println!("  下一步：");
    println!("    cc-connect {} --project default", platform.setup_cmd);
    if cc_connect_supports_daemon() {
        println!("    cc-connect daemon install       # 安装为后台服务");
    } else {
        println!("    pm2 start cc-connect -- --project default   # 或使用其他进程管理器");
    }
    println!();
    0
}

/// `cc-connect --version`, if the binary is on PATH.
fn cc_connect_version() -> Option<String> {
    let output = Command::new("cc-connect").arg("--version").output().ok()?;
    if !output.status.success() {
        return None;
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    let first = stdout.lines().next().unwrap_or("").trim();
    if first.is_empty() {
        None
    } else {
        Some(first.to_string())
    }
}

/// Whether the installed cc-connect supports `daemon install`.
fn cc_connect_supports_daemon() -> bool {
    match Command::new("cc-connect")
        .args(["daemon", "--help"])
        .output()
    {
        Ok(output) => {
            let text = String::from_utf8_lossy(&output.stdout);
            text.contains("install") && !text.contains("not supported")
        }
        Err(_) => false,
    }
}

/// Path of the current `lm` binary plus the `stream-json` sub-command.
fn detect_lm_path() -> String {
    if let Ok(current) = std::env::current_exe() {
        let name = current
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("");
        if name.eq_ignore_ascii_case("lm") || name.eq_ignore_ascii_case("lm.exe") {
            return format!("{} stream-json", current.display());
        }
    }
    // Fall back to a PATH lookup.
    let lookup = if cfg!(windows) { "where" } else { "which" };
    if let Ok(output) = Command::new(lookup).arg("lm").output()
        && output.status.success()
    {
        let first = String::from_utf8_lossy(&output.stdout)
            .lines()
            .next()
            .unwrap_or("")
            .trim()
            .to_string();
        if !first.is_empty() {
            return format!("{first} stream-json");
        }
    }
    "lm stream-json".to_string()
}

fn cc_connect_config_path() -> PathBuf {
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".cc-connect")
        .join("config.toml")
}

fn generate_config(cli_path: &str, platform_type: &str) -> String {
    let work_dir = std::env::current_dir()
        .map(|path| path.display().to_string())
        .unwrap_or_default();
    [
        "# 全局：允许/禁止图片和文件回传到聊天（on = 开启，off = 关闭）",
        "attachment_send = \"on\"",
        "",
        "[[projects]]",
        "name = \"default\"",
        "",
        "[projects.agent]",
        "type = \"claudecode\"",
        "",
        "[projects.agent.options]",
        &format!("cli_path = '{}'", cli_path),
        &format!("work_dir = '{}'", work_dir),
        "mode = \"default\"",
        "",
        "[[projects.platforms]]",
        &format!("type = \"{}\"", platform_type),
        "",
    ]
    .join("\n")
}
