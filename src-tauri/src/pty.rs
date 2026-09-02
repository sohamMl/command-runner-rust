use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::Arc;
use parking_lot::Mutex;
use tauri::{AppHandle, Emitter};

pub struct PtySession {
    pub writer: Box<dyn Write + Send>,
    pub master: Box<dyn MasterPty + Send>,
    pub killer: Box<dyn portable_pty::ChildKiller + Send + Sync>,
}

#[derive(Clone)]
pub struct PtyManager {
    sessions: Arc<Mutex<HashMap<String, PtySession>>>,
}

#[derive(Serialize, Clone)]
pub struct PtyOutputPayload {
    pub id: String,
    pub data: String,
}

#[derive(Serialize, Clone)]
pub struct PtyExitPayload {
    pub id: String,
    pub exit_code: i32,
}

impl PtyManager {
    pub fn new() -> Self {
        Self {
            sessions: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    pub fn spawn_command(
        &self,
        app: AppHandle,
        id: String,
        command_str: String,
        working_dir: Option<String>,
        env_vars_str: Option<String>,
        requires_sudo: bool,
        global_sudo: bool,
        cols: u16,
        rows: u16,
    ) -> Result<(), String> {
        // If already running, stop old session first
        self.stop_command(&id);

        let pty_system = native_pty_system();
        let pair = pty_system
            .openpty(PtySize {
                rows: if rows == 0 { 24 } else { rows },
                cols: if cols == 0 { 80 } else { cols },
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| format!("Failed to open PTY: {}", e))?;

        let mut final_cmd = command_str.clone();
        if requires_sudo || global_sudo {
            let escaped = final_cmd.replace('\'', "'\\''");
            if global_sudo {
                final_cmd = format!("sudo sh -c '{}'", escaped);
            } else {
                final_cmd = format!("pkexec sh -c '{}'", escaped);
            }
        }

        let mut cmd = CommandBuilder::new("sh");
        cmd.args(["-c", &final_cmd]);

        if let Some(wd) = working_dir {
            if !wd.trim().is_empty() {
                cmd.cwd(wd);
            }
        }

        cmd.env("TERM", "xterm-256color");
        cmd.env("COLORTERM", "truecolor");

        if let Some(env_str) = env_vars_str {
            if !env_str.trim().is_empty() {
                if let Some(pairs) = shlex::split(&env_str) {
                    for pair in pairs {
                        if let Some((k, v)) = pair.split_once('=') {
                            cmd.env(k, v);
                        }
                    }
                }
            }
        }

        let mut child = pair
            .slave
            .spawn_command(cmd)
            .map_err(|e| format!("Failed to spawn command: {}", e))?;

        let killer = child.clone_killer();
        let writer = pair
            .master
            .take_writer()
            .map_err(|e| format!("Failed to take PTY writer: {}", e))?;
        let mut reader = pair
            .master
            .try_clone_reader()
            .map_err(|e| format!("Failed to clone PTY reader: {}", e))?;

        {
            let mut lock = self.sessions.lock();
            lock.insert(
                id.clone(),
                PtySession {
                    writer,
                    master: pair.master,
                    killer,
                },
            );
        }

        let cmd_id_out = id.clone();
        let app_handle_out = app.clone();

        let (tx, rx) = std::sync::mpsc::sync_channel::<Vec<u8>>(512);

        // Raw PTY reader thread
        std::thread::spawn(move || {
            let mut buf = [0u8; 4096];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => {
                        if tx.send(buf[..n].to_vec()).is_err() {
                            break;
                        }
                    }
                    Err(_) => break,
                }
            }
        });

        // Batched IPC emitter thread (coalesces bursts to prevent flooding GTK/WebKit event loop)
        std::thread::spawn(move || {
            let mut accumulated = Vec::with_capacity(8192);
            loop {
                match rx.recv() {
                    Ok(first_chunk) => {
                        accumulated.extend_from_slice(&first_chunk);

                        // Collect any other immediately available chunks
                        while let Ok(chunk) = rx.try_recv() {
                            accumulated.extend_from_slice(&chunk);
                            if accumulated.len() >= 65536 {
                                break;
                            }
                        }

                        // If chunk is small, brief wait to coalesce fast-paced output like curses redraws
                        if accumulated.len() < 8192 {
                            let timeout = std::time::Duration::from_millis(15);
                            if let Ok(extra) = rx.recv_timeout(timeout) {
                                accumulated.extend_from_slice(&extra);
                                while let Ok(chunk) = rx.try_recv() {
                                    accumulated.extend_from_slice(&chunk);
                                    if accumulated.len() >= 65536 {
                                        break;
                                    }
                                }
                            }
                        }

                        let text = String::from_utf8_lossy(&accumulated).to_string();
                        accumulated.clear();

                        let _ = app_handle_out.emit(
                            &format!("pty-output-{}", cmd_id_out),
                            PtyOutputPayload {
                                id: cmd_id_out.clone(),
                                data: text,
                            },
                        );
                    }
                    Err(_) => break,
                }
            }
        });

        // Child process wait thread
        let cmd_id_exit = id.clone();
        let sessions_clone = self.sessions.clone();

        std::thread::spawn(move || {
            let status = child.wait();
            let exit_code = match status {
                Ok(s) => {
                    if s.success() {
                        0
                    } else {
                        1
                    }
                }
                Err(_) => -1,
            };

            {
                let mut lock = sessions_clone.lock();
                lock.remove(&cmd_id_exit);
            }

            let _ = app.emit(
                &format!("pty-exit-{}", cmd_id_exit),
                PtyExitPayload {
                    id: cmd_id_exit,
                    exit_code,
                },
            );
        });

        Ok(())
    }

    pub fn write_data(&self, id: &str, data: &str) -> Result<(), String> {
        let mut lock = self.sessions.lock();
        if let Some(session) = lock.get_mut(id) {
            session
                .writer
                .write_all(data.as_bytes())
                .map_err(|e| format!("Failed to write to PTY: {}", e))?;
            session
                .writer
                .flush()
                .map_err(|e| format!("Failed to flush PTY: {}", e))?;
            Ok(())
        } else {
            Err("Session not found".to_string())
        }
    }

    pub fn resize(&self, id: &str, cols: u16, rows: u16) -> Result<(), String> {
        let mut lock = self.sessions.lock();
        if let Some(session) = lock.get_mut(id) {
            session
                .master
                .resize(PtySize {
                    rows: if rows == 0 { 24 } else { rows },
                    cols: if cols == 0 { 80 } else { cols },
                    pixel_width: 0,
                    pixel_height: 0,
                })
                .map_err(|e| format!("Failed to resize PTY: {}", e))?;
            Ok(())
        } else {
            Err("Session not found".to_string())
        }
    }

    pub fn stop_command(&self, id: &str) -> bool {
        let mut lock = self.sessions.lock();
        if let Some(mut session) = lock.remove(id) {
            let _ = session.killer.kill();
            true
        } else {
            false
        }
    }

    pub fn is_running(&self, id: &str) -> bool {
        let lock = self.sessions.lock();
        lock.contains_key(id)
    }
}
