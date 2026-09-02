# Command Runner (Tauri 2.0 + Rust)

A modern, high-performance, cross-distro command manager with embedded terminal emulation and system tray integration.

## Features
- **Cross-Distro Compatibility**: Works across Fedora, Ubuntu, Arch, KDE, GNOME, etc.
- **Embedded xterm.js Terminal**: Full ANSI colors, live resize, scrollback, and export.
- **Pseudo-Terminal (PTY)**: Powered by Rust `portable-pty`.
- **System Tray**: Native status icon with minimize-to-tray.
- **Template Variables**: Interactive modal for `{{placeholder}}` variables.
- **Sudo / Elevated Privileges**: Per-command elevation via `pkexec` or global sudo.
- **Import / Export**: JSON configuration with drag-and-drop reordering.

## Development

```bash
# Install frontend dependencies
npm install

# Run in development mode
npm run tauri dev
```

## Build Release Binary

```bash
npm run tauri build
```
