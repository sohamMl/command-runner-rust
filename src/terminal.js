import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

export class TerminalManager {
  constructor(containerEl, commandId) {
    this.container = containerEl;
    this.commandId = commandId;
    this.term = null;
    this.fitAddon = null;
    this.unlistenOutput = null;
    this.unlistenExit = null;
    this.outputBuffer = '';
    this.lastCols = 0;
    this.lastRows = 0;
    this.resizeTimer = null;

    this.init();
  }

  init() {
    this.term = new Terminal({
      theme: {
        background: '#121212',
        foreground: '#f3f4f6',
        cursor: '#3584e4',
        black: '#1f2937',
        red: '#ef4444',
        green: '#10b981',
        yellow: '#f59e0b',
        blue: '#3b82f6',
        magenta: '#ec4899',
        cyan: '#06b6d4',
        white: '#f9fafb',
      },
      fontFamily: `'JetBrains Mono', 'Fira Code', monospace`,
      fontSize: 13,
      cursorBlink: true,
      convertEol: true,
      rows: 10,
      cols: 80,
    });

    this.fitAddon = new FitAddon();
    this.term.loadAddon(this.fitAddon);
    this.term.loadAddon(new WebLinksAddon());

    this.term.open(this.container);
    this.scheduleFit(50);

    // Send user keystrokes into the Rust PTY
    this.term.onData((data) => {
      invoke('write_pty', { id: this.commandId, data }).catch(() => {});
    });

    // Resize observer throttled/debounced to prevent layout thrashing and SIGWINCH flood
    this.resizeObserver = new ResizeObserver(() => {
      this.scheduleFit(100);
    });
    this.resizeObserver.observe(this.container);
  }

  scheduleFit(delay = 80) {
    if (this.resizeTimer) {
      clearTimeout(this.resizeTimer);
    }
    this.resizeTimer = setTimeout(() => {
      this.resizeTimer = null;
      this.fit();
    }, delay);
  }

  fit() {
    if (!this.term || !this.container || !this.fitAddon) return;
    if (this.container.offsetParent === null) return;
    if (this.container.clientWidth < 50 || this.container.clientHeight < 50) return;

    try {
      this.fitAddon.fit();
      const cols = this.term.cols;
      const rows = this.term.rows;
      if (cols > 0 && rows > 0 && (cols !== this.lastCols || rows !== this.lastRows)) {
        this.lastCols = cols;
        this.lastRows = rows;
        invoke('resize_pty', {
          id: this.commandId,
          cols,
          rows,
        }).catch(() => {});
      }
    } catch (_) {}
  }

  async attachListeners(onExitCallback) {
    if (this.unlistenOutput) {
      this.unlistenOutput();
      this.unlistenOutput = null;
    }
    if (this.unlistenExit) {
      this.unlistenExit();
      this.unlistenExit = null;
    }

    this.unlistenOutput = await listen(`pty-output-${this.commandId}`, (event) => {
      if (event.payload && event.payload.data) {
        this.term.write(event.payload.data);
        if (this.outputBuffer.length < 500000) {
          this.outputBuffer += event.payload.data;
        } else {
          this.outputBuffer = this.outputBuffer.slice(-250000) + event.payload.data;
        }
      }
    });

    this.unlistenExit = await listen(`pty-exit-${this.commandId}`, (event) => {
      const exitCode = event.payload ? event.payload.exit_code : 0;
      this.term.write(`\r\n\x1b[90m[Process exited with code ${exitCode}]\x1b[0m\r\n`);
      if (onExitCallback) {
        onExitCallback(exitCode);
      }
    });
  }

  clear() {
    if (this.term) {
      this.term.clear();
      this.term.reset();
      this.outputBuffer = '';
    }
  }

  getDimensions() {
    return {
      cols: this.term && this.term.cols > 0 ? this.term.cols : 80,
      rows: this.term && this.term.rows > 0 ? this.term.rows : 24,
    };
  }

  getOutputText() {
    return this.outputBuffer;
  }

  destroy() {
    if (this.resizeTimer) {
      clearTimeout(this.resizeTimer);
      this.resizeTimer = null;
    }
    if (this.resizeObserver) {
      this.resizeObserver.disconnect();
      this.resizeObserver = null;
    }
    if (this.unlistenOutput) {
      this.unlistenOutput();
      this.unlistenOutput = null;
    }
    if (this.unlistenExit) {
      this.unlistenExit();
      this.unlistenExit = null;
    }
    if (this.term) {
      this.term.dispose();
      this.term = null;
    }
  }
}
