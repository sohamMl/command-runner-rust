use serde::{Deserialize, Serialize};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::PathBuf;
use std::sync::Arc;
use parking_lot::RwLock;
use uuid::Uuid;
use chrono::Local;

#[cfg(unix)]
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CommandItem {
    pub id: String,
    pub name: String,
    pub command: String,
    #[serde(default)]
    pub description: String,
    #[serde(default = "default_emoji")]
    pub emoji: String,
    #[serde(default = "default_category")]
    pub category: String,
    #[serde(default)]
    pub requires_sudo: bool,
    #[serde(default)]
    pub working_dir: String,
    #[serde(default)]
    pub env_vars: String,
    #[serde(default)]
    pub last_run: String,
    #[serde(default)]
    pub last_exit_code: Option<i32>,
}

fn default_emoji() -> String {
    "🚀".to_string()
}

fn default_category() -> String {
    "General".to_string()
}

#[derive(Clone)]
pub struct ConfigManager {
    commands: Arc<RwLock<Vec<CommandItem>>>,
    config_path: PathBuf,
}

impl ConfigManager {
    pub fn new() -> Self {
        let config_dir = dirs_config_dir().join("command-runner");
        let config_path = config_dir.join("config.json");

        let manager = Self {
            commands: Arc::new(RwLock::new(Vec::new())),
            config_path,
        };

        manager.ensure_config_dir();
        manager.load();
        manager
    }

    fn ensure_config_dir(&self) {
        if let Some(parent) = self.config_path.parent() {
            if !parent.exists() {
                let _ = fs::create_dir_all(parent);
                #[cfg(unix)]
                {
                    let _ = fs::set_permissions(parent, fs::Permissions::from_mode(0o700));
                }
            }
        }
    }

    pub fn load(&self) {
        if !self.config_path.exists() {
            return;
        }

        if let Ok(content) = fs::read_to_string(&self.config_path) {
            if let Ok(items) = serde_json::from_str::<Vec<CommandItem>>(&content) {
                let mut lock = self.commands.write();
                *lock = items;
            }
        }
    }

    pub fn save(&self) -> Result<(), String> {
        self.ensure_config_dir();
        let items = self.commands.read().clone();
        let json_str = serde_json::to_string_pretty(&items)
            .map_err(|e| format!("Failed to serialize config: {}", e))?;

        let temp_path = self.config_path.with_extension("tmp");

        #[cfg(unix)]
        let mut file = OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .mode(0o600)
            .open(&temp_path)
            .map_err(|e| format!("Failed to create temp config: {}", e))?;

        #[cfg(not(unix))]
        let mut file = OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .open(&temp_path)
            .map_err(|e| format!("Failed to create temp config: {}", e))?;

        file.write_all(json_str.as_bytes())
            .map_err(|e| format!("Failed to write config: {}", e))?;
        file.sync_all()
            .map_err(|e| format!("Failed to sync config: {}", e))?;

        fs::rename(&temp_path, &self.config_path)
            .map_err(|e| format!("Failed to atomically update config: {}", e))?;

        Ok(())
    }

    pub fn get_all(&self) -> Vec<CommandItem> {
        self.commands.read().clone()
    }

    pub fn add_command(&self, mut item: CommandItem) -> Result<CommandItem, String> {
        if item.id.is_empty() {
            item.id = Uuid::new_v4().to_string();
        }
        if item.emoji.is_empty() {
            item.emoji = "🚀".to_string();
        }
        if item.category.is_empty() {
            item.category = "General".to_string();
        }

        let added = item.clone();
        {
            let mut lock = self.commands.write();
            lock.push(item);
        }
        self.save()?;
        Ok(added)
    }

    pub fn update_command(&self, item: CommandItem) -> Result<bool, String> {
        let mut found = false;
        {
            let mut lock = self.commands.write();
            for cmd in lock.iter_mut() {
                if cmd.id == item.id {
                    *cmd = item.clone();
                    found = true;
                    break;
                }
            }
        }
        if found {
            self.save()?;
        }
        Ok(found)
    }

    pub fn delete_command(&self, id: &str) -> Result<bool, String> {
        let removed = {
            let mut lock = self.commands.write();
            let initial_len = lock.len();
            lock.retain(|c| c.id != id);
            lock.len() < initial_len
        };
        if removed {
            self.save()?;
        }
        Ok(removed)
    }

    pub fn duplicate_command(&self, id: &str) -> Result<Option<CommandItem>, String> {
        let mut cloned = None;
        {
            let mut lock = self.commands.write();
            if let Some(target) = lock.iter().find(|c| c.id == id).cloned() {
                let mut new_cmd = target;
                new_cmd.id = Uuid::new_v4().to_string();
                new_cmd.name = format!("{} (copy)", new_cmd.name);
                new_cmd.last_run = String::new();
                new_cmd.last_exit_code = None;
                cloned = Some(new_cmd.clone());
                lock.push(new_cmd);
            }
        }
        if cloned.is_some() {
            self.save()?;
        }
        Ok(cloned)
    }

    pub fn reorder_commands(&self, ordered_ids: Vec<String>) -> Result<(), String> {
        {
            let mut lock = self.commands.write();
            let mut map = std::collections::HashMap::new();
            for cmd in lock.drain(..) {
                map.insert(cmd.id.clone(), cmd);
            }

            let mut reordered = Vec::new();
            for id in &ordered_ids {
                if let Some(cmd) = map.remove(id) {
                    reordered.push(cmd);
                }
            }
            // Append any remaining
            for (_, cmd) in map {
                reordered.push(cmd);
            }
            *lock = reordered;
        }
        self.save()
    }

    pub fn record_run(&self, id: &str, exit_code: i32) -> Result<(), String> {
        let now_str = Local::now().to_rfc3339();
        {
            let mut lock = self.commands.write();
            for cmd in lock.iter_mut() {
                if cmd.id == id {
                    cmd.last_run = now_str.clone();
                    cmd.last_exit_code = Some(exit_code);
                    break;
                }
            }
        }
        self.save()
    }

    pub fn export_config(&self, path: &str) -> Result<usize, String> {
        let items = self.commands.read().clone();
        let json_str = serde_json::to_string_pretty(&items)
            .map_err(|e| format!("Failed to serialize config: {}", e))?;
        fs::write(path, json_str)
            .map_err(|e| format!("Failed to write export file: {}", e))?;
        Ok(items.len())
    }

    pub fn import_config(&self, path: &str, merge: bool) -> Result<usize, String> {
        let content = fs::read_to_string(path)
            .map_err(|e| format!("Failed to read import file: {}", e))?;
        let imported: Vec<CommandItem> = serde_json::from_str(&content)
            .map_err(|e| format!("Invalid configuration JSON format: {}", e))?;

        let count = imported.len();
        {
            let mut lock = self.commands.write();
            if merge {
                let existing_ids: std::collections::HashSet<String> =
                    lock.iter().map(|c| c.id.clone()).collect();
                for mut cmd in imported {
                    if !existing_ids.contains(&cmd.id) {
                        if cmd.id.is_empty() {
                            cmd.id = Uuid::new_v4().to_string();
                        }
                        lock.push(cmd);
                    }
                }
            } else {
                *lock = imported;
            }
        }
        self.save()?;
        Ok(count)
    }
}

fn dirs_config_dir() -> PathBuf {
    if let Ok(xdg) = std::env::var("XDG_CONFIG_HOME") {
        if !xdg.is_empty() {
            return PathBuf::from(xdg);
        }
    }
    if let Ok(home) = std::env::var("HOME") {
        return PathBuf::from(home).join(".config");
    }
    PathBuf::from(".")
}
