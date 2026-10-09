//! `Skill` tool — load a skill's full instructions on demand.

use std::path::Path;

use async_trait::async_trait;
use serde_json::json;

use super::Tool;
use crate::skill::SkillDefinition;

pub struct SkillTool {
    skills: Vec<SkillDefinition>,
}

impl SkillTool {
    pub fn new(skills: Vec<SkillDefinition>) -> Self {
        Self { skills }
    }
}

#[async_trait]
impl Tool for SkillTool {
    fn name(&self) -> &str {
        "Skill"
    }

    fn description(&self) -> &str {
        "Invoke a skill by name: returns the skill's full instructions (its SKILL.md). \
         Use this when the user asks for a skill or when a listed skill's workflow \
         matches the task."
    }

    fn parameters_schema(&self) -> serde_json::Value {
        json!({
            "type": "object",
            "properties": {
                "skill": {
                    "type": "string",
                    "description": "Name of the skill to load (as listed in the available skills)."
                }
            },
            "required": ["skill"]
        })
    }

    fn requires_approval(&self) -> bool {
        false
    }

    async fn execute(&self, arguments: &serde_json::Value, _cwd: &Path) -> Result<String, String> {
        let requested = arguments["skill"]
            .as_str()
            .ok_or("missing `skill` argument")?
            .trim();
        if requested.is_empty() {
            return Err("skill name cannot be empty".to_string());
        }
        let Some(skill) = self.skills.iter().find(|skill| skill.name == requested) else {
            let available: Vec<&str> = self
                .skills
                .iter()
                .map(|skill| skill.name.as_str())
                .collect();
            return Err(format!(
                "unknown skill `{requested}`. Available skills: {}",
                if available.is_empty() {
                    "(none)".to_string()
                } else {
                    available.join(", ")
                }
            ));
        };
        skill.load_body()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::skill::SkillSource;

    fn demo_skill() -> (tempfile::TempDir, SkillDefinition) {
        let dir = tempfile::tempdir().unwrap();
        let skill_dir = dir.path().join("demo");
        std::fs::create_dir_all(&skill_dir).unwrap();
        std::fs::write(
            skill_dir.join("SKILL.md"),
            "---\nname: demo\ndescription: d\n---\n\n# Demo body\nfollow these steps\n",
        )
        .unwrap();
        let skill = SkillDefinition {
            name: "demo".to_string(),
            description: "d".to_string(),
            path: skill_dir.join("SKILL.md"),
            source: SkillSource::User,
        };
        (dir, skill)
    }

    #[tokio::test]
    async fn loads_the_skill_body() {
        let (_dir, skill) = demo_skill();
        let tool = SkillTool::new(vec![skill]);
        let body = tool
            .execute(&serde_json::json!({"skill": "demo"}), Path::new("."))
            .await
            .unwrap();
        assert!(body.contains("# Demo body"), "got: {body}");
        assert!(!body.contains("description: d"));
    }

    #[tokio::test]
    async fn unknown_skill_lists_available_names() {
        let (_dir, skill) = demo_skill();
        let tool = SkillTool::new(vec![skill]);
        let error = tool
            .execute(&serde_json::json!({"skill": "nope"}), Path::new("."))
            .await
            .unwrap_err();
        assert!(error.contains("unknown skill"), "got: {error}");
        assert!(error.contains("demo"), "got: {error}");
    }
}
