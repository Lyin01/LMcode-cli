//! Skill discovery — scans the same directories as the TS implementation and
//! renders the skill list injected into the system prompt.
//!
//! Lookup order: project (`.lmcode/skills`, `.agents/skills`) wins over user
//! (`~/.lmcode/skills`, `~/.agents/skills`) on name collisions. Each skill is
//! either a directory containing `SKILL.md` or a standalone `.md` file.

use std::collections::HashSet;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SkillSource {
    User,
    Project,
}

impl SkillSource {
    fn title(&self) -> &'static str {
        match self {
            Self::Project => "Project",
            Self::User => "User",
        }
    }
}

/// One discovered skill.
#[derive(Debug, Clone)]
pub struct SkillDefinition {
    pub name: String,
    pub description: String,
    /// Path of the skill's markdown file.
    pub path: PathBuf,
    pub source: SkillSource,
}

impl SkillDefinition {
    /// Load the full instructions (the file body, frontmatter stripped).
    pub fn load_body(&self) -> Result<String, String> {
        let content = std::fs::read_to_string(&self.path).map_err(|error| {
            format!("failed to read skill file {}: {error}", self.path.display())
        })?;
        Ok(strip_frontmatter(&content).to_string())
    }
}

/// Discover skills from project and user directories.
pub fn discover_skills(cwd: &Path) -> Vec<SkillDefinition> {
    let mut skills: Vec<SkillDefinition> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();

    for directory in [
        cwd.join(".lmcode").join("skills"),
        cwd.join(".agents").join("skills"),
    ] {
        collect_directory(&directory, SkillSource::Project, &mut skills, &mut seen);
    }
    if let Some(home) = dirs::home_dir() {
        for directory in [
            home.join(".lmcode").join("skills"),
            home.join(".agents").join("skills"),
        ] {
            collect_directory(&directory, SkillSource::User, &mut skills, &mut seen);
        }
    }

    skills.sort_by(|a, b| a.name.cmp(&b.name));
    skills
}

/// Discover skills from explicit directories (CLI `--skills-dir`).
///
/// Mirrors the legacy CLI contract: when directories are given explicitly,
/// automatic project/user discovery is skipped entirely.
pub fn discover_skills_in(dirs: &[std::path::PathBuf]) -> Vec<SkillDefinition> {
    let mut skills: Vec<SkillDefinition> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    for directory in dirs {
        collect_directory(directory, SkillSource::Project, &mut skills, &mut seen);
    }
    skills.sort_by(|a, b| a.name.cmp(&b.name));
    skills
}

fn collect_directory(
    directory: &Path,
    source: SkillSource,
    skills: &mut Vec<SkillDefinition>,
    seen: &mut HashSet<String>,
) {
    let Ok(entries) = std::fs::read_dir(directory) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let skill_file = if path.is_dir() {
            path.join("SKILL.md")
        } else if path
            .extension()
            .map(|extension| extension == "md")
            .unwrap_or(false)
        {
            path.clone()
        } else {
            continue;
        };
        if !skill_file.is_file() {
            continue;
        }
        if let Some(skill) = parse_skill_file(&skill_file, source)
            && seen.insert(skill.name.clone())
        {
            skills.push(skill);
        }
    }
}

fn parse_skill_file(path: &Path, source: SkillSource) -> Option<SkillDefinition> {
    let content = std::fs::read_to_string(path).ok()?;
    let frontmatter = extract_frontmatter(&content)?;
    let name = frontmatter_field(&frontmatter, "name")?;
    if name.trim().is_empty() {
        return None;
    }
    let description = frontmatter_field(&frontmatter, "description").unwrap_or_default();
    Some(SkillDefinition {
        name: name.trim().to_string(),
        description: description.trim().to_string(),
        path: path.to_path_buf(),
        source,
    })
}

/// Extract the text between the opening and closing `---` fences.
fn extract_frontmatter(content: &str) -> Option<String> {
    let content = content.strip_prefix('\u{feff}').unwrap_or(content);
    let rest = content.strip_prefix("---")?;
    let end = rest.find("\n---")?;
    Some(rest[..end].to_string())
}

/// Strip the frontmatter block from a skill file body.
fn strip_frontmatter(content: &str) -> &str {
    let content = content.strip_prefix('\u{feff}').unwrap_or(content);
    if let Some(rest) = content.strip_prefix("---")
        && let Some(end) = rest.find("\n---")
    {
        let body_start = 3 + end + 4; // opening fence + block + closing fence line
        return content
            .get(body_start..)
            .unwrap_or(content)
            .trim_start_matches('\n');
    }
    content
}

fn frontmatter_field(frontmatter: &str, key: &str) -> Option<String> {
    let prefix = format!("{key}:");
    for line in frontmatter.lines() {
        let line = line.trim();
        if let Some(value) = line.strip_prefix(&prefix) {
            let value = value.trim();
            let value = value
                .strip_prefix('"')
                .and_then(|inner| inner.strip_suffix('"'))
                .unwrap_or(value);
            let value = value
                .strip_prefix('\'')
                .and_then(|inner| inner.strip_suffix('\''))
                .unwrap_or(value);
            return Some(value.to_string());
        }
    }
    None
}

/// Render the skill list injected into the system prompt.
pub fn render_skill_prompt(skills: &[SkillDefinition]) -> String {
    if skills.is_empty() {
        return String::new();
    }
    let mut lines =
        vec!["DISREGARD any earlier skill listings. Current available skills:".to_string()];
    for source in [SkillSource::Project, SkillSource::User] {
        let group: Vec<&SkillDefinition> = skills
            .iter()
            .filter(|skill| skill.source == source)
            .collect();
        if group.is_empty() {
            continue;
        }
        lines.push(format!("### {}", source.title()));
        for skill in group {
            lines.push(format!("- {}: {}", skill.name, skill.description));
            lines.push(format!("  Path: {}", skill.path.display()));
        }
    }
    lines.join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write_skill(dir: &Path, name: &str, description: &str) {
        let skill_dir = dir.join(name);
        std::fs::create_dir_all(&skill_dir).unwrap();
        std::fs::write(
            skill_dir.join("SKILL.md"),
            format!(
                "---\nname: {name}\ndescription: {description}\n---\n\n# Body\ninstructions here\n"
            ),
        )
        .unwrap();
    }

    #[test]
    fn extracts_frontmatter_with_quotes_and_bom() {
        let content = "\u{feff}---\nname: \"my-skill\"\ndescription: 'Does things'\n---\nbody";
        let frontmatter = extract_frontmatter(content).unwrap();
        assert_eq!(frontmatter_field(&frontmatter, "name").unwrap(), "my-skill");
        assert_eq!(
            frontmatter_field(&frontmatter, "description").unwrap(),
            "Does things"
        );
        assert!(frontmatter_field(&frontmatter, "missing").is_none());
    }

    #[test]
    fn strip_frontmatter_returns_the_body() {
        let content = "---\nname: x\ndescription: y\n---\n\n# Heading\ntext";
        assert_eq!(strip_frontmatter(content), "# Heading\ntext");
        assert_eq!(strip_frontmatter("no frontmatter"), "no frontmatter");
    }

    #[test]
    fn discovers_project_and_user_skills_with_project_priority() {
        let project = tempfile::tempdir().unwrap();
        let home = tempfile::tempdir().unwrap();
        write_skill(
            &project.path().join(".agents").join("skills"),
            "shared",
            "project version",
        );
        write_skill(
            &project.path().join(".agents").join("skills"),
            "only-project",
            "p",
        );
        write_skill(
            &home.path().join(".agents").join("skills"),
            "shared",
            "user version",
        );
        write_skill(
            &home.path().join(".agents").join("skills"),
            "only-user",
            "u",
        );

        // discover_skills uses dirs::home_dir(); simulate by scanning directly.
        let mut skills = Vec::new();
        let mut seen = HashSet::new();
        collect_directory(
            &project.path().join(".agents").join("skills"),
            SkillSource::Project,
            &mut skills,
            &mut seen,
        );
        collect_directory(
            &home.path().join(".agents").join("skills"),
            SkillSource::User,
            &mut skills,
            &mut seen,
        );
        skills.sort_by(|a, b| a.name.cmp(&b.name));

        assert_eq!(
            skills.len(),
            3,
            "duplicate name collapses to project version"
        );
        let shared = skills.iter().find(|skill| skill.name == "shared").unwrap();
        assert_eq!(shared.source, SkillSource::Project);
        assert_eq!(shared.description, "project version");
    }

    #[test]
    fn renders_grouped_skill_prompt() {
        let skills = vec![
            SkillDefinition {
                name: "alpha".to_string(),
                description: "first".to_string(),
                path: PathBuf::from("/p/alpha/SKILL.md"),
                source: SkillSource::Project,
            },
            SkillDefinition {
                name: "beta".to_string(),
                description: "second".to_string(),
                path: PathBuf::from("/u/beta/SKILL.md"),
                source: SkillSource::User,
            },
        ];
        let rendered = render_skill_prompt(&skills);
        assert!(rendered.starts_with("DISREGARD any earlier skill listings."));
        assert!(rendered.contains("### Project"));
        assert!(rendered.contains("### User"));
        assert!(rendered.contains("- alpha: first"));
        assert!(rendered.contains("Path: /p/alpha/SKILL.md"));
        assert!(render_skill_prompt(&[]).is_empty());
    }

    #[test]
    fn loads_skill_body_without_frontmatter() {
        let dir = tempfile::tempdir().unwrap();
        write_skill(dir.path(), "demo", "d");
        let skill =
            parse_skill_file(&dir.path().join("demo").join("SKILL.md"), SkillSource::User).unwrap();
        let body = skill.load_body().unwrap();
        assert!(body.starts_with("# Body"), "got: {body:?}");
        assert!(!body.contains("name: demo"));
    }
}
