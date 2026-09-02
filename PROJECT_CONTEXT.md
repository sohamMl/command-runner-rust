# Project Context: Command Runner (Tauri 2.0 + Rust)

## 1. Project Overview & Motivation
**Command Runner** is a lightweight, high-performance desktop application for running, managing, and organizing terminal commands with custom parameters, embedded terminals, system tray integration, and elevated privileges (`sudo`/`pkexec`).

### Why the Rewrite from Python to Tauri 2.0?
The original version was written in Python using **GTK 4, Libadwaita, and VTE**. While functional on stock GNOME on recent Fedora/Ubuntu, it faced several cross-distro friction points:
1. **C-Library Dependency Hell**: Required users to manually hunt down and install distro-specific packages (`vte291-gtk4`, `gir1.2-vte-3.91`, `vte4`, `python3-gobject`, `libadwaita`, `libappindicator-gtk3`).
2. **System Tray Conflicts**: GTK4 lacks native `libappindicator` bindings, forcing the Python version to spawn a secondary GTK3 subprocess communicating over D-Bus just to show a tray icon.
3. **Fragile Theming on Non-GNOME Desktops**: Libadwaita styling caused issues on KDE Plasma and lightweight window managers.

### The Solution: Tauri 2.0 + Rust + xterm.js
- **Zero VTE C-library dependency**: Embedded **`xterm.js`** in a native webview provides 100% consistent ANSI color formatting, live resizing, and keystroke forwarding on any Linux distribution (Fedora, Ubuntu, Arch, KDE Plasma, GNOME, etc.).
- **Rust PTY Engine**: [`portable-pty`](https://crates.io/crates/portable-pty) handles real Linux pseudo-terminals directly.
- **Native StatusNotifierItem / System Tray**: Tauri 2.0 provides native tray support across Wayland and X11 without secondary helper processes.
- **Single Portable Executable**: Low resource footprint (~15MB binary, ~30-40MB RAM).

---

## 2. Directory Structure & File Map

```
/home/soham/Documents/gitreps/command-runner-rust/
├── index.html                 # Main UI markup, header bar, cards container, and modals
├── package.json               # Frontend dependencies (@xterm, @tauri-apps/api, vite)
├── vite.config.js             # Vite configuration tailored for Tauri 2.0 dev & build
├── dist/                      # Compiled production frontend bundle (generated via vite build)
├── src/
│   ├── styles.css             # Modern Libadwaita/GNOME dark design system & animations
│   ├── main.js                # App state, IPC invokes, search, drag & drop, modals
│   ├── terminal.js            # xterm.js lifecycle, FitAddon, Tauri event streaming
│   └── dialogs.js             # Categorized emoji picker with search
└── src-tauri/
    ├── Cargo.toml             # Rust dependencies (tauri 2.0, portable-pty, serde, etc.)
    ├── build.rs               # Tauri build script
    ├── tauri.conf.json        # Tauri 2.0 app window, security, and tray configurations
    ├── capabilities/
    │   └── default.json       # Tauri 2.0 permissions (core, shell, dialog, fs)
    ├── icons/                 # 32x32.png, 128x128.png, icon.png
    └── src/
        ├── main.rs            # Entry point invoking command_runner_lib::run()
        ├── lib.rs             # Tauri command registration, state setup, window events
        ├── config.rs          # Thread-safe config CRUD, atomic saves (0600 permissions)
        ├── pty.rs             # PTY session manager, bidirectional streaming, process lifecycle
        └── tray.rs            # Native system tray builder and event handlers
```

---

## 3. Detailed Component Architecture

### A. Backend (`src-tauri/`)

#### 1. Config Manager ([`src-tauri/src/config.rs`](file:///home/soham/Documents/gitreps/command-runner-rust/src-tauri/src/config.rs))
- **Thread Safety**: Wrapped in `Arc<parking_lot::RwLock<Vec<CommandItem>>>`.
- **File Storage**: Located at `$XDG_CONFIG_HOME/command-runner/config.json` (defaults to `~/.config/command-runner/config.json`).
- **Security & Reliability**:
  - Sets directory permissions to `0700` and config file to `0600` on Unix.
  - Implements **atomic writes**: writes JSON to `config.json.tmp` and executes `fs::rename` to prevent file corruption during crashes or power loss.
  - 100% backward-compatible with the Python version's `config.json` format.
- **Operations**:
  - `add_command`, `update_command`, `delete_command`, `duplicate_command`
  - `reorder_commands` (supports drag-and-drop reordering)
  - `record_run` (saves last run timestamp and return exit code)
  - `export_config` & `import_config` (supports merging imported commands by UUID)

#### 2. PTY Subsystem ([`src-tauri/src/pty.rs`](file:///home/soham/Documents/gitreps/command-runner-rust/src-tauri/src/pty.rs))
- **Spawning**: Uses `portable_pty::native_pty_system()` to allocate master/slave PTY pairs.
- **Privilege Elevation**: Automatically detects `requires_sudo` or `global_sudo` and wraps commands into `pkexec sh -c '...'` or `sudo sh -c '...'` with single-quote escaping.
- **Environment & Working Dir**: Parses custom `KEY=VAL` environment strings using `shlex::split` without crashing on malformed input; sets working directory if specified.
- **Bidirectional Streaming**:
  - Background reader thread streams output to frontend via `pty-output-{id}` Tauri events.
  - Child wait thread captures exit code and emits `pty-exit-{id}`.
  - `write_pty(id, data)` forwards keystrokes from xterm.js into PTY stdin.
  - `resize_pty(id, cols, rows)` resizes the PTY dynamically when the window/container is resized.
  - `stop_command(id)` terminates the process via `portable_pty::ChildKiller`.

#### 3. Native System Tray ([`src-tauri/src/tray.rs`](file:///home/soham/Documents/gitreps/command-runner-rust/src-tauri/src/tray.rs))
- Uses Tauri 2.0 `TrayIconBuilder`.
- Native menu: "Show Command Runner", "Hide to Tray", "Quit".
- Single left-click toggles window visibility.
- Window close button intercepts `CloseRequested` and minimizes to tray instead of quitting (`lib.rs`).

---

### B. Frontend (`src/` & `index.html`)

#### 1. Terminal Component ([`src/terminal.js`](file:///home/soham/Documents/gitreps/command-runner-rust/src/terminal.js))
- Instantiates `@xterm/xterm` with `@xterm/addon-fit` and `@xterm/addon-web-links`.
- Auto-resizes using `ResizeObserver` and dispatches `resize_pty` to the backend.
- Listens for `pty-output-{id}` and `pty-exit-{id}` events.
- Captures buffer text for output file export.

#### 2. UI & Interaction ([`src/main.js`](file:///home/soham/Documents/gitreps/command-runner-rust/src/main.js))
- **Commands Categorization**: Dynamically groups cards into collapsible category accordions.
- **Search & Filter**: Real-time filtering by name, command content, or description (`Ctrl+F` shortcut).
- **Template Variables**: Automatically detects `{{placeholder}}` strings (e.g. `ping {{host}}`, `git checkout {{branch}}`) and displays an interactive form modal before execution.
- **Drag & Drop Reordering**: Uses HTML5 drag-and-drop on command cards and updates persistent order via `reorder_commands`.
- **Global Sudo Toggle**: Global lock icon in header to elevate all executed commands via `sudo`.
- **Import / Export**: Native file dialogs for JSON import and export.
- **Toast Notifications**: Built-in non-blocking toast overlay for user feedback.

#### 3. Stylesheet ([`src/styles.css`](file:///home/soham/Documents/gitreps/command-runner-rust/src/styles.css))
- Modern dark theme adhering to GNOME/Libadwaita color tokens (`#1e1e1e`, `#252525`, `#2e2e2e`, `#3584e4`, `#33d17a`, `#e01b24`).
- Glassmorphism dialogs, smooth transitions, status badges, and spinners.

---

## 4. Tauri IPC API Reference

| Command Name | Arguments | Returns | Description |
|---|---|---|---|
| `get_commands` | None | `Vec<CommandItem>` | Retrieve all saved commands |
| `add_command` | `{ item: CommandItem }` | `CommandItem` | Create a new command with generated UUID |
| `update_command` | `{ item: CommandItem }` | `bool` | Update an existing command |
| `delete_command` | `{ id: String }` | `bool` | Delete command by ID |
| `duplicate_command` | `{ id: String }` | `Option<CommandItem>` | Clone command with `(copy)` suffix |
| `reorder_commands` | `{ orderedIds: Vec<String> }` | `()` | Update display ordering |
| `record_run` | `{ id: String, exitCode: i32 }` | `()` | Record execution timestamp & status |
| `export_config` | `{ path: String }` | `usize` | Export commands list to JSON |
| `import_config` | `{ path: String, merge: bool }` | `usize` | Import and optionally merge JSON |
| `run_command` | `{ id, command, workingDir, envVars, requiresSudo, globalSudo, cols, rows }` | `()` | Spawn shell command in PTY |
| `write_pty` | `{ id: String, data: String }` | `()` | Write user input to PTY stdin |
| `resize_pty` | `{ id: String, cols: u16, rows: u16 }` | `()` | Resize active PTY window |
| `stop_command` | `{ id: String }` | `bool` | Terminate running process |
| `check_command_running` | `{ id: String }` | `bool` | Check if session is active |
| `save_file` | `{ path: String, content: String }` | `()` | Write terminal output to disk |

---

## 5. Security Improvements over Legacy Version

1. **Eliminated Sudo Keepalive Loop**: Removed the infinite background `sudo -v` polling daemon that had previously exposed system-wide passwordless sudo to user-space malware.
2. **Safe Env Parsing**: `shlex::split` is safely wrapped with error handling to avoid unhandled exceptions on unbalanced quotes.
3. **Atomic File Writes & Permissions**: Set `0600` permissions on `$XDG_CONFIG_HOME/command-runner/config.json` to safeguard secrets/tokens from other local users.
4. **Thread-Safe Subprocess Spawning**: Eliminated deprecated `preexec_fn=os.setsid` in favor of standard, deadlock-free PTY spawning.

---

## 6. Build & Verification Status

- **Rust Backend**: Compiles cleanly with `cargo check` (0 errors, 0 warnings).
- **Frontend**: Successfully bundled with Vite (`npm run build` -> `dist/`).

### How to Run in Development:
```bash
cd /home/soham/Documents/gitreps/command-runner-rust
npm run tauri dev
```

### How to Compile Release Binary:
```bash
cd /home/soham/Documents/gitreps/command-runner-rust
npm run tauri build
```
*(Build requirement on Fedora: `sudo dnf install webkit2gtk4.1-devel openssl-devel`)*

---

## 7. Next Steps for Future Sessions
1. **Live App Validation**: Run `npm run tauri dev` to test interactive execution of commands, variable inputs, and terminal output.
2. **Packaging Setup**: Configure `.deb`, `.rpm`, or AppImage bundling targets in `tauri.conf.json` for one-click release distribution.
3. **Desktop Entry**: Create a standard `com.gemini.commandrunner.desktop` file for system launcher integration.
