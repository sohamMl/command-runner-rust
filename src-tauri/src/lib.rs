mod config;
mod pty;
mod tray;

use config::{CommandItem, ConfigManager};
use pty::PtyManager;
use std::sync::Arc;
use tauri::{AppHandle, Manager, State, WindowEvent};

pub struct AppState {
    pub config: ConfigManager,
    pub pty: PtyManager,
}

#[tauri::command]
fn get_commands(state: State<Arc<AppState>>) -> Vec<CommandItem> {
    state.config.get_all()
}

#[tauri::command]
fn add_command(item: CommandItem, state: State<Arc<AppState>>) -> Result<CommandItem, String> {
    state.config.add_command(item)
}

#[tauri::command]
fn update_command(item: CommandItem, state: State<Arc<AppState>>) -> Result<bool, String> {
    state.config.update_command(item)
}

#[tauri::command]
fn delete_command(id: String, state: State<Arc<AppState>>) -> Result<bool, String> {
    state.config.delete_command(&id)
}

#[tauri::command]
fn duplicate_command(id: String, state: State<Arc<AppState>>) -> Result<Option<CommandItem>, String> {
    state.config.duplicate_command(&id)
}

#[tauri::command]
fn reorder_commands(ordered_ids: Vec<String>, state: State<Arc<AppState>>) -> Result<(), String> {
    state.config.reorder_commands(ordered_ids)
}

#[tauri::command]
fn record_run(id: String, exit_code: i32, state: State<Arc<AppState>>) -> Result<(), String> {
    state.config.record_run(&id, exit_code)
}

#[tauri::command]
fn export_config(path: String, state: State<Arc<AppState>>) -> Result<usize, String> {
    state.config.export_config(&path)
}

#[tauri::command]
fn import_config(path: String, merge: bool, state: State<Arc<AppState>>) -> Result<usize, String> {
    state.config.import_config(&path, merge)
}

#[tauri::command]
fn run_command(
    app: AppHandle,
    id: String,
    command: String,
    working_dir: Option<String>,
    env_vars: Option<String>,
    requires_sudo: bool,
    global_sudo: bool,
    cols: u16,
    rows: u16,
    state: State<Arc<AppState>>,
) -> Result<(), String> {
    state.pty.spawn_command(
        app,
        id,
        command,
        working_dir,
        env_vars,
        requires_sudo,
        global_sudo,
        cols,
        rows,
    )
}

#[tauri::command]
fn write_pty(id: String, data: String, state: State<Arc<AppState>>) -> Result<(), String> {
    state.pty.write_data(&id, &data)
}

#[tauri::command]
fn resize_pty(id: String, cols: u16, rows: u16, state: State<Arc<AppState>>) -> Result<(), String> {
    state.pty.resize(&id, cols, rows)
}

#[tauri::command]
fn stop_command(id: String, state: State<Arc<AppState>>) -> bool {
    state.pty.stop_command(&id)
}

#[tauri::command]
fn check_command_running(id: String, state: State<Arc<AppState>>) -> bool {
    state.pty.is_running(&id)
}

#[tauri::command]
fn save_file(path: String, content: String) -> Result<(), String> {
    std::fs::write(&path, content).map_err(|e| format!("Failed to save file: {}", e))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app_state = Arc::new(AppState {
        config: ConfigManager::new(),
        pty: PtyManager::new(),
    });

    tauri::Builder::default()
        .plugin(
            tauri_plugin_log::Builder::new()
                .targets([
                    tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::Stdout),
                    tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::LogDir {
                        file_name: Some("command-runner".to_string()),
                    }),
                    tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::Webview),
                ])
                .level(log::LevelFilter::Debug)
                .build(),
        )
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .manage(app_state)
        .invoke_handler(tauri::generate_handler![
            get_commands,
            add_command,
            update_command,
            delete_command,
            duplicate_command,
            reorder_commands,
            record_run,
            export_config,
            import_config,
            run_command,
            write_pty,
            resize_pty,
            stop_command,
            check_command_running,
            save_file
        ])
        .setup(|app| {
            let handle = app.handle();
            let _ = tray::setup_tray(handle);

            if let Some(window) = app.get_webview_window("main") {
                let win = window.clone();
                window.on_window_event(move |event| {
                    if let WindowEvent::CloseRequested { api, .. } = event {
                        api.prevent_close();
                        let _ = win.hide();
                    }
                });
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running command-runner application");
}
