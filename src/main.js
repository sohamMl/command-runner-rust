import { invoke } from '@tauri-apps/api/core';
import { open, save } from '@tauri-apps/plugin-dialog';
import { TerminalManager } from './terminal.js';
import { setupEmojiPicker } from './dialogs.js';

class CommandRunnerApp {
  constructor() {
    this.commands = [];
    this.terminals = new Map();
    this.runningStates = new Map();
    this.monitorTimers = new Map();
    this.globalSudo = false;
    this.editingId = null;

    this.cacheDom();
    this.bindEvents();
    this.loadCommands();
  }

  cacheDom() {
    this.container = document.getElementById('commands-container');
    this.emptyState = document.getElementById('empty-state');
    this.searchInput = document.getElementById('search-input');
    this.searchClear = document.getElementById('search-clear');
    this.btnAdd = document.getElementById('btn-add');
    this.btnSudo = document.getElementById('btn-sudo');
    this.btnRefresh = document.getElementById('btn-refresh');
    this.btnMenu = document.getElementById('btn-menu');
    this.menuDropdown = document.getElementById('menu-dropdown');

    // Modals
    this.modalCommand = document.getElementById('modal-command');
    this.modalCommandTitle = document.getElementById('modal-command-title');
    this.cmdName = document.getElementById('cmd-name');
    this.cmdCommand = document.getElementById('cmd-command');
    this.cmdCategory = document.getElementById('cmd-category');
    this.cmdEmojiBtn = document.getElementById('cmd-emoji-btn');
    this.cmdDesc = document.getElementById('cmd-description');
    this.cmdInterval = document.getElementById('cmd-interval');
    this.customIntervalGroup = document.getElementById('custom-interval-group');
    this.cmdCustomInterval = document.getElementById('cmd-custom-interval');
    this.intervalHint = document.getElementById('interval-hint');
    this.cmdTermHeight = document.getElementById('cmd-term-height');
    this.customTermHeightGroup = document.getElementById('custom-term-height-group');
    this.cmdCustomTermHeight = document.getElementById('cmd-custom-term-height');
    this.cmdWorkdir = document.getElementById('cmd-workdir');
    this.cmdEnv = document.getElementById('cmd-env');
    this.cmdSudo = document.getElementById('cmd-sudo');
    this.btnSaveCommand = document.getElementById('btn-save-command');

    // Advanced toggle
    this.advancedToggle = document.getElementById('advanced-toggle');
    this.advancedContent = document.getElementById('advanced-content');

    // Emoji
    setupEmojiPicker(
      this.cmdEmojiBtn,
      document.getElementById('emoji-popover'),
      document.getElementById('emoji-search'),
      document.getElementById('emoji-grid'),
      (emoji) => { this.selectedEmoji = emoji; }
    );
    this.selectedEmoji = '🚀';

    // Variable Modal
    this.modalVar = document.getElementById('modal-variable');
    this.varTemplateCode = document.getElementById('var-template-code');
    this.varFieldsContainer = document.getElementById('var-fields-container');
    this.btnRunVar = document.getElementById('btn-run-var');

    // Confirm Modal
    this.modalConfirm = document.getElementById('modal-confirm');
    this.btnConfirmOk = document.getElementById('btn-confirm-ok');
    this.confirmMessage = document.getElementById('confirm-message');
  }

  bindEvents() {
    // Shortcuts
    window.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'n') {
        e.preventDefault();
        this.openAddModal();
      }
      if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
        e.preventDefault();
        this.searchInput.focus();
      }
      if (e.key === 'Escape') {
        this.closeAllModals();
        this.searchInput.value = '';
        this.filterCommands();
      }
    });

    this.btnAdd.addEventListener('click', () => this.openAddModal());
    this.btnRefresh.addEventListener('click', () => this.loadCommands());
    this.btnSudo.addEventListener('click', () => this.toggleGlobalSudo());

    this.searchInput.addEventListener('input', () => {
      this.searchClear.classList.toggle('hidden', !this.searchInput.value);
      this.filterCommands();
    });
    this.searchClear.addEventListener('click', () => {
      this.searchInput.value = '';
      this.searchClear.classList.add('hidden');
      this.filterCommands();
    });

    // Menu
    this.btnMenu.addEventListener('click', (e) => {
      e.stopPropagation();
      this.menuDropdown.classList.toggle('hidden');
    });
    document.addEventListener('click', () => this.menuDropdown.classList.add('hidden'));

    document.getElementById('menu-import').addEventListener('click', () => this.importConfig());
    document.getElementById('menu-export').addEventListener('click', () => this.exportConfig());
    document.getElementById('menu-about').addEventListener('click', () => {
      this.showToast('Command Runner v1.0.0 (Tauri 2.0)');
    });

    // Modal close buttons
    document.getElementById('modal-command-close').addEventListener('click', () => this.closeModal(this.modalCommand));
    document.getElementById('btn-cancel-command').addEventListener('click', () => this.closeModal(this.modalCommand));
    document.getElementById('modal-var-close').addEventListener('click', () => this.closeModal(this.modalVar));
    document.getElementById('btn-cancel-var').addEventListener('click', () => this.closeModal(this.modalVar));
    document.getElementById('modal-confirm-close').addEventListener('click', () => this.closeModal(this.modalConfirm));
    document.getElementById('btn-confirm-cancel').addEventListener('click', () => this.closeModal(this.modalConfirm));

    this.btnSaveCommand.addEventListener('click', () => this.saveCommandForm());

    this.cmdInterval.addEventListener('change', () => {
      const isCustom = this.cmdInterval.value === 'custom';
      this.customIntervalGroup.classList.toggle('hidden', !isCustom);
      if (isCustom) this.cmdCustomInterval.focus();
      const isInterval = this.cmdInterval.value !== '0';
      this.intervalHint.classList.toggle('hidden', !isInterval);
    });

    this.cmdTermHeight.addEventListener('change', () => {
      const isCustom = this.cmdTermHeight.value === 'custom';
      this.customTermHeightGroup.classList.toggle('hidden', !isCustom);
      if (isCustom) this.cmdCustomTermHeight.focus();
    });

    this.advancedToggle.addEventListener('click', () => {
      this.advancedContent.classList.toggle('hidden');
    });

    document.getElementById('btn-browse-dir').addEventListener('click', async () => {
      const selected = await open({ directory: true, multiple: false });
      if (selected) this.cmdWorkdir.value = selected;
    });
  }

  async loadCommands() {
    try {
      this.commands = await invoke('get_commands');
      this.render();
    } catch (err) {
      this.showToast(`Error loading commands: ${err}`);
    }
  }

  render() {
    // Cleanup active timers and previous terminals to prevent leaks/dangling observers
    this.monitorTimers.forEach(t => clearTimeout(t));
    this.monitorTimers.clear();
    this.terminals.forEach(tm => tm.destroy());
    this.terminals.clear();

    this.container.innerHTML = '';
    if (!this.commands || this.commands.length === 0) {
      this.emptyState.classList.remove('hidden');
      return;
    }
    this.emptyState.classList.add('hidden');

    // Group by category
    const categories = {};
    for (const cmd of this.commands) {
      const cat = cmd.category || 'General';
      if (!categories[cat]) categories[cat] = [];
      categories[cat].push(cmd);
    }

    Object.keys(categories).sort().forEach(catName => {
      const groupEl = document.createElement('div');
      groupEl.className = 'category-group';
      groupEl.dataset.category = catName;

      const headerEl = document.createElement('div');
      headerEl.className = 'category-header';
      headerEl.innerHTML = `
        <svg class="category-chevron" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="6 9 12 15 18 9"></polyline></svg>
        <span class="category-title">${catName}</span>
        <span class="category-count">${categories[catName].length}</span>
      `;
      headerEl.addEventListener('click', () => groupEl.classList.toggle('collapsed'));
      groupEl.appendChild(headerEl);

      const listEl = document.createElement('div');
      listEl.className = 'category-list';

      categories[catName].forEach(cmd => {
        const card = this.createCommandCard(cmd);
        listEl.appendChild(card);
      });

      groupEl.appendChild(listEl);
      this.container.appendChild(groupEl);
    });

    this.setupDragDrop();
  }

  createCommandCard(cmd) {
    const card = document.createElement('div');
    card.className = 'command-card';
    card.dataset.id = cmd.id;
    card.draggable = true;

    const isRunning = this.runningStates.get(cmd.id) || false;
    const badgeClass = cmd.last_exit_code === 0 ? 'badge-success' : (cmd.last_exit_code !== null && cmd.last_exit_code !== undefined ? 'badge-error' : '');
    const intervalBadge = (cmd.interval_seconds && cmd.interval_seconds > 0)
      ? `<span class="tag-interval" title="Auto-refreshes every ${cmd.interval_seconds}s">🔄 ${cmd.interval_seconds}s</span>`
      : '';

    card.innerHTML = `
      <div class="command-main-row">
        <div class="drag-handle" title="Drag to reorder">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><circle cx="8" cy="5" r="2"></circle><circle cx="16" cy="5" r="2"></circle><circle cx="8" cy="12" r="2"></circle><circle cx="16" cy="12" r="2"></circle><circle cx="8" cy="19" r="2"></circle><circle cx="16" cy="19" r="2"></circle></svg>
        </div>

        <div class="icon-wrapper">
          <span class="emoji-icon">${cmd.emoji || '🚀'}</span>
          ${badgeClass ? `<span class="badge-status ${badgeClass}"></span>` : ''}
          <div class="spinner ${isRunning ? '' : 'hidden'}"></div>
        </div>

        <div class="command-info">
          <div class="command-title-row">
            <span class="command-name">${cmd.name}</span>
            ${cmd.requires_sudo ? '<span class="tag-sudo">sudo</span>' : ''}
            ${intervalBadge}
          </div>
          ${cmd.description ? `<span class="command-desc">${cmd.description}</span>` : ''}
          <div><code class="command-code">$ ${cmd.command}</code></div>
          ${cmd.last_run ? `<span class="command-meta">Last run: ${new Date(cmd.last_run).toLocaleString()}</span>` : ''}
        </div>

        <div class="command-actions">
          <button class="btn btn-primary btn-run">${isRunning ? 'Stop' : (cmd.interval_seconds > 0 ? 'Monitor' : 'Run')}</button>
          <button class="btn btn-icon btn-save-output" title="Save Output">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"></path><polyline points="17 21 17 13 7 13 7 21"></polyline><polyline points="7 3 7 8 15 8"></polyline></svg>
          </button>
          <button class="btn btn-icon btn-toggle-term" title="Toggle Terminal">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="4 17 10 11 4 5"></polyline><line x1="12" y1="19" x2="20" y2="19"></line></svg>
          </button>
          <button class="btn btn-icon btn-expand-term" title="Expand Size">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="15 3 21 3 21 9"></polyline><polyline points="9 21 3 21 3 15"></polyline><line x1="21" y1="3" x2="14" y2="10"></line><line x1="3" y1="21" x2="10" y2="14"></line></svg>
          </button>
          <button class="btn btn-icon btn-edit" title="Edit">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path></svg>
          </button>
          <button class="btn btn-icon btn-duplicate" title="Duplicate">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>
          </button>
          <button class="btn btn-icon btn-delete" title="Delete">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>
          </button>
        </div>
      </div>

      <div class="terminal-wrapper hidden">
        <div class="terminal-container"></div>
      </div>
    `;

    // Terminal container reference
    const termWrapper = card.querySelector('.terminal-wrapper');
    const termContainer = card.querySelector('.terminal-container');

    // Prevent drag from starting inside the terminal area (crashes WebKitGTK)
    termWrapper.addEventListener('mousedown', (e) => e.stopPropagation());
    termWrapper.addEventListener('dragstart', (e) => {
      e.preventDefault();
      e.stopPropagation();
    });
    termWrapper.setAttribute('draggable', 'false');

    const btnRun = card.querySelector('.btn-run');
    btnRun.addEventListener('click', () => this.handleRunStop(cmd, card));

    card.querySelector('.btn-toggle-term').addEventListener('click', () => {
      const isHidden = termWrapper.classList.toggle('hidden');
      if (!isHidden) {
        let tm = this.terminals.get(cmd.id);
        if (!tm) {
          tm = new TerminalManager(termContainer, cmd.id);
          this.terminals.set(cmd.id, tm);
        } else {
          setTimeout(() => tm.scheduleFit(), 50);
        }
      }
    });

    card.querySelector('.btn-expand-term').addEventListener('click', () => {
      if (termWrapper.classList.contains('hidden')) {
        termWrapper.classList.remove('hidden');
      }
      let tm = this.terminals.get(cmd.id);
      if (!tm) {
        tm = new TerminalManager(termContainer, cmd.id);
        this.terminals.set(cmd.id, tm);
      }
      // Pause observer during class toggle to prevent resize feedback loop
      if (tm.resizeObserver) tm.resizeObserver.disconnect();
      const isNowExpanded = termWrapper.classList.toggle('expanded');
      if (isNowExpanded) {
        const height = cmd.terminal_height || 480;
        termWrapper.style.height = `${height}px`;
      } else {
        termWrapper.style.height = '';
      }
      // Re-observe and fit after layout settles
      setTimeout(() => {
        if (tm.resizeObserver && tm.container) {
          tm.resizeObserver.observe(tm.container);
        }
        tm.scheduleFit();
      }, 150);
    });

    card.querySelector('.btn-save-output').addEventListener('click', async () => {
      const tm = this.terminals.get(cmd.id);
      if (!tm) return this.showToast('No terminal output to save');
      const text = tm.getOutputText();
      const path = await save({ defaultPath: `${cmd.name.replace(/\s+/g, '_')}_output.txt` });
      if (path) {
        await invoke('save_file', { path, content: text });
        this.showToast('Output saved to file');
      }
    });

    card.querySelector('.btn-edit').addEventListener('click', () => this.openEditModal(cmd));
    card.querySelector('.btn-duplicate').addEventListener('click', () => this.duplicateCommand(cmd.id));
    card.querySelector('.btn-delete').addEventListener('click', () => this.confirmDelete(cmd));

    return card;
  }

  updateCardStatus(card, cmd) {
    if (!card) return;
    const iconWrapper = card.querySelector('.icon-wrapper');
    if (iconWrapper) {
      let badgeStatus = iconWrapper.querySelector('.badge-status');
      const badgeClass = cmd.last_exit_code === 0 ? 'badge-success' : (cmd.last_exit_code !== null && cmd.last_exit_code !== undefined ? 'badge-error' : '');
      if (badgeClass) {
        if (!badgeStatus) {
          badgeStatus = document.createElement('span');
          badgeStatus.className = 'badge-status';
          iconWrapper.insertBefore(badgeStatus, iconWrapper.querySelector('.spinner'));
        }
        badgeStatus.className = `badge-status ${badgeClass}`;
      } else if (badgeStatus) {
        badgeStatus.remove();
      }
    }

    const infoEl = card.querySelector('.command-info');
    if (infoEl && cmd.last_run) {
      let metaEl = infoEl.querySelector('.command-meta');
      if (!metaEl) {
        metaEl = document.createElement('span');
        metaEl.className = 'command-meta';
        infoEl.appendChild(metaEl);
      }
      metaEl.textContent = `Last run: ${new Date(cmd.last_run).toLocaleString()}`;
    }
  }

  async handleRunStop(cmd, card) {
    const isRunning = this.runningStates.get(cmd.id) || this.monitorTimers.has(cmd.id);
    const btnRun = card.querySelector('.btn-run');
    const spinner = card.querySelector('.spinner');
    const intervalSecs = cmd.interval_seconds || 0;

    if (isRunning) {
      if (this.monitorTimers.has(cmd.id)) {
        clearTimeout(this.monitorTimers.get(cmd.id));
        this.monitorTimers.delete(cmd.id);
      }
      this.runningStates.set(cmd.id, false);
      await invoke('stop_command', { id: cmd.id }).catch(() => {});
      btnRun.textContent = intervalSecs > 0 ? 'Monitor' : 'Run';
      btnRun.classList.remove('btn-danger');
      btnRun.classList.add('btn-primary');
      spinner.classList.add('hidden');
      return;
    }

    // Check for variables {{var}}
    const placeholders = [...new Set(Array.from(cmd.command.matchAll(/\{\{(\w+)\}\}/g), m => m[1]))];
    if (placeholders.length > 0) {
      this.openVariableModal(cmd, placeholders, (finalCmd) => {
        this.executeCommand(cmd, card, finalCmd);
      });
    } else {
      this.executeCommand(cmd, card, cmd.command);
    }
  }

  async executeCommand(cmd, card, commandString) {
    const btnRun = card.querySelector('.btn-run');
    const spinner = card.querySelector('.spinner');
    const termWrapper = card.querySelector('.terminal-wrapper');
    const termContainer = card.querySelector('.terminal-container');

    termWrapper.classList.remove('hidden');

    let tm = this.terminals.get(cmd.id);
    if (!tm) {
      tm = new TerminalManager(termContainer, cmd.id);
      this.terminals.set(cmd.id, tm);
    }
    tm.clear();
    setTimeout(() => tm.fit(), 50);

    const intervalSecs = cmd.interval_seconds || 0;

    this.runningStates.set(cmd.id, true);
    btnRun.textContent = 'Stop';
    btnRun.classList.remove('btn-primary');
    btnRun.classList.add('btn-danger');
    spinner.classList.remove('hidden');

    const runIteration = async () => {
      if (!this.runningStates.get(cmd.id)) return;

      const dims = tm.getDimensions();
      // If periodic monitor mode, clear previous output frame before redrawing cleanly
      if (intervalSecs > 0) {
        tm.clear(true);
      }

      await tm.attachListeners(async (exitCode) => {
        await invoke('record_run', { id: cmd.id, exitCode }).catch(() => {});
        cmd.last_exit_code = exitCode;
        cmd.last_run = new Date().toISOString();
        this.updateCardStatus(card, cmd);

        // If periodic monitoring is active and still running, schedule next iteration
        if (intervalSecs > 0 && this.runningStates.get(cmd.id)) {
          const timerId = setTimeout(() => {
            this.monitorTimers.delete(cmd.id);
            runIteration();
          }, intervalSecs * 1000);
          this.monitorTimers.set(cmd.id, timerId);
        } else {
          this.runningStates.set(cmd.id, false);
          btnRun.textContent = intervalSecs > 0 ? 'Monitor' : 'Run';
          btnRun.classList.remove('btn-danger');
          btnRun.classList.add('btn-primary');
          spinner.classList.add('hidden');
        }
      }, intervalSecs > 0);

      try {
        await invoke('run_command', {
          id: cmd.id,
          command: commandString,
          workingDir: cmd.working_dir || null,
          envVars: cmd.env_vars || null,
          requiresSudo: cmd.requires_sudo || false,
          globalSudo: this.globalSudo,
          cols: dims.cols,
          rows: dims.rows,
        });
      } catch (err) {
        this.showToast(`Error running command: ${err}`);
        this.runningStates.set(cmd.id, false);
        if (this.monitorTimers.has(cmd.id)) {
          clearTimeout(this.monitorTimers.get(cmd.id));
          this.monitorTimers.delete(cmd.id);
        }
        btnRun.textContent = intervalSecs > 0 ? 'Monitor' : 'Run';
        btnRun.classList.remove('btn-danger');
        btnRun.classList.add('btn-primary');
        spinner.classList.add('hidden');
      }
    };

    runIteration();
  }

  openAddModal() {
    this.editingId = null;
    this.modalCommandTitle.textContent = 'New Command';
    this.cmdName.value = '';
    this.cmdCommand.value = '';
    this.cmdCategory.value = 'General';
    this.cmdEmojiBtn.textContent = '🚀';
    this.selectedEmoji = '🚀';
    this.cmdDesc.value = '';
    this.cmdInterval.value = '0';
    this.customIntervalGroup.classList.add('hidden');
    this.cmdCustomInterval.value = '';
    this.intervalHint.classList.add('hidden');
    this.cmdTermHeight.value = '480';
    this.customTermHeightGroup.classList.add('hidden');
    this.cmdCustomTermHeight.value = '';
    this.cmdWorkdir.value = '';
    this.cmdEnv.value = '';
    this.cmdSudo.checked = false;
    this.advancedContent.classList.add('hidden');
    this.modalCommand.classList.remove('hidden');
    this.cmdName.focus();
  }

  openEditModal(cmd) {
    this.editingId = cmd.id;
    this.modalCommandTitle.textContent = 'Edit Command';
    this.cmdName.value = cmd.name;
    this.cmdCommand.value = cmd.command;
    this.cmdCategory.value = cmd.category || 'General';
    this.cmdEmojiBtn.textContent = cmd.emoji || '🚀';
    this.selectedEmoji = cmd.emoji || '🚀';
    this.cmdDesc.value = cmd.description || '';

    const secs = cmd.interval_seconds || 0;
    if (['0', '1', '2', '3', '5', '10', '30', '60'].includes(String(secs))) {
      this.cmdInterval.value = String(secs);
      this.customIntervalGroup.classList.add('hidden');
      this.cmdCustomInterval.value = '';
    } else {
      this.cmdInterval.value = 'custom';
      this.customIntervalGroup.classList.remove('hidden');
      this.cmdCustomInterval.value = secs;
    }
    this.intervalHint.classList.toggle('hidden', secs === 0);

    const termH = cmd.terminal_height || 480;
    if (['320', '480', '600', '750'].includes(String(termH))) {
      this.cmdTermHeight.value = String(termH);
      this.customTermHeightGroup.classList.add('hidden');
      this.cmdCustomTermHeight.value = '';
    } else {
      this.cmdTermHeight.value = 'custom';
      this.customTermHeightGroup.classList.remove('hidden');
      this.cmdCustomTermHeight.value = termH;
    }

    this.cmdWorkdir.value = cmd.working_dir || '';
    this.cmdEnv.value = cmd.env_vars || '';
    this.cmdSudo.checked = cmd.requires_sudo || false;
    this.modalCommand.classList.remove('hidden');
  }

  async saveCommandForm() {
    const name = this.cmdName.value.trim();
    const command = this.cmdCommand.value.trim();
    if (!name || !command) {
      return this.showToast('Please fill in Name and Command');
    }

    let intervalSecs = null;
    if (this.cmdInterval.value === 'custom') {
      const customVal = parseInt(this.cmdCustomInterval.value, 10);
      if (customVal && customVal > 0) intervalSecs = customVal;
    } else {
      const standardVal = parseInt(this.cmdInterval.value, 10);
      if (standardVal && standardVal > 0) intervalSecs = standardVal;
    }

    let termHeight = null;
    if (this.cmdTermHeight.value === 'custom') {
      const customH = parseInt(this.cmdCustomTermHeight.value, 10);
      if (customH && customH >= 150) termHeight = customH;
    } else {
      const standardH = parseInt(this.cmdTermHeight.value, 10);
      if (standardH && standardH !== 480) termHeight = standardH;
    }

    const payload = {
      id: this.editingId || '',
      name,
      command,
      category: this.cmdCategory.value.trim() || 'General',
      emoji: this.selectedEmoji || '🚀',
      description: this.cmdDesc.value.trim(),
      interval_seconds: intervalSecs,
      terminal_height: termHeight,
      working_dir: this.cmdWorkdir.value.trim(),
      env_vars: this.cmdEnv.value.trim(),
      requires_sudo: this.cmdSudo.checked,
      last_run: '',
      last_exit_code: null,
    };

    try {
      if (this.editingId) {
        await invoke('update_command', { item: payload });
        this.showToast('✏️ Command updated');
      } else {
        await invoke('add_command', { item: payload });
        this.showToast('✅ Command added');
      }
      this.closeModal(this.modalCommand);
      this.loadCommands();
    } catch (err) {
      this.showToast(`Failed to save: ${err}`);
    }
  }

  async duplicateCommand(id) {
    try {
      await invoke('duplicate_command', { id });
      this.showToast('📋 Command duplicated');
      this.loadCommands();
    } catch (err) {
      this.showToast(`Error duplicating: ${err}`);
    }
  }

  confirmDelete(cmd) {
    this.confirmMessage.textContent = `Are you sure you want to delete "${cmd.name}"?`;
    this.modalConfirm.classList.remove('hidden');
    this.btnConfirmOk.onclick = async () => {
      try {
        await invoke('delete_command', { id: cmd.id });
        this.showToast('🗑️ Command deleted');
        this.closeModal(this.modalConfirm);
        this.loadCommands();
      } catch (err) {
        this.showToast(`Error deleting: ${err}`);
      }
    };
  }

  openVariableModal(cmd, placeholders, onConfirm) {
    this.varTemplateCode.textContent = cmd.command;
    this.varFieldsContainer.innerHTML = '';

    const inputs = {};
    placeholders.forEach(ph => {
      const row = document.createElement('div');
      row.className = 'form-group';
      row.innerHTML = `
        <label for="var-input-${ph}">${ph}</label>
        <input type="text" id="var-input-${ph}" placeholder="Value for ${ph}" required />
      `;
      this.varFieldsContainer.appendChild(row);
      inputs[ph] = row.querySelector('input');
    });

    this.modalVar.classList.remove('hidden');
    if (placeholders.length > 0) inputs[placeholders[0]].focus();

    this.btnRunVar.onclick = () => {
      let finalCmd = cmd.command;
      for (const ph of placeholders) {
        const val = inputs[ph].value;
        finalCmd = finalCmd.replaceAll(`{{${ph}}}`, val);
      }
      this.closeModal(this.modalVar);
      onConfirm(finalCmd);
    };
  }

  toggleGlobalSudo() {
    this.globalSudo = !this.globalSudo;
    this.btnSudo.classList.toggle('btn-active', this.globalSudo);
    this.showToast(this.globalSudo ? '🔓 Global Sudo enabled' : '🔒 Global Sudo disabled');
  }

  filterCommands() {
    const query = this.searchInput.value.toLowerCase().trim();
    const groups = document.querySelectorAll('.category-group');

    groups.forEach(group => {
      let matchCount = 0;
      const cards = group.querySelectorAll('.command-card');
      cards.forEach(card => {
        const id = card.dataset.id;
        const cmd = this.commands.find(c => c.id === id);
        if (!cmd) return;
        const match = !query ||
          cmd.name.toLowerCase().includes(query) ||
          cmd.command.toLowerCase().includes(query) ||
          (cmd.description && cmd.description.toLowerCase().includes(query));

        card.classList.toggle('hidden', !match);
        if (match) matchCount++;
      });
      group.classList.toggle('hidden', matchCount === 0);
    });
  }

  setupDragDrop() {
    const cards = document.querySelectorAll('.command-card');
    cards.forEach(card => {
      card.addEventListener('dragstart', (e) => {
        // If drag originated from inside terminal, button, or code block, prevent it
        if (e.target.closest && (e.target.closest('.terminal-wrapper') || e.target.closest('.command-actions') || e.target.closest('code') || e.target.closest('button'))) {
          e.preventDefault();
          return;
        }

        const cmd = this.commands.find(c => c.id === card.dataset.id);

        // Explicit lightweight ghost image to prevent WebKitGTK from snapshotting XTerm canvas
        const ghost = document.createElement('div');
        ghost.style.position = 'fixed';
        ghost.style.top = '-9999px';
        ghost.style.left = '-9999px';
        ghost.style.padding = '8px 16px';
        ghost.style.background = '#2e2e2e';
        ghost.style.color = '#ffffff';
        ghost.style.borderRadius = '8px';
        ghost.style.fontSize = '13px';
        ghost.style.fontWeight = '600';
        ghost.style.border = '1px solid #3584e4';
        ghost.style.boxShadow = '0 8px 24px rgba(0,0,0,0.5)';
        ghost.style.zIndex = '99999';
        ghost.style.pointerEvents = 'none';
        ghost.textContent = cmd ? `${cmd.emoji || '🚀'} ${cmd.name}` : 'Command';
        document.body.appendChild(ghost);

        if (e.dataTransfer && e.dataTransfer.setDragImage) {
          e.dataTransfer.setDragImage(ghost, 20, 20);
        }
        setTimeout(() => ghost.remove(), 100);

        card.classList.add('dragging');
        e.dataTransfer.setData('text/plain', card.dataset.id);
        e.dataTransfer.effectAllowed = 'move';
      });

      card.addEventListener('dragend', () => card.classList.remove('dragging'));
      card.addEventListener('dragover', (e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
      });

      card.addEventListener('drop', async (e) => {
        e.preventDefault();
        const srcId = e.dataTransfer.getData('text/plain');
        const destId = card.dataset.id;
        if (srcId && destId && srcId !== destId) {
          const ids = this.commands.map(c => c.id);
          const srcIdx = ids.indexOf(srcId);
          const destIdx = ids.indexOf(destId);
          if (srcIdx !== -1 && destIdx !== -1) {
            ids.splice(srcIdx, 1);
            ids.splice(destIdx, 0, srcId);
            await invoke('reorder_commands', { orderedIds: ids });
            this.showToast('Reordered');

            // Reorder DOM in-place to preserve active terminal sessions
            const srcCard = this.container.querySelector(`[data-id="${srcId}"]`);
            const destCard = this.container.querySelector(`[data-id="${destId}"]`);
            if (srcCard && destCard) {
              const destParent = destCard.parentNode;
              if (srcIdx < destIdx) {
                destParent.insertBefore(srcCard, destCard.nextSibling);
              } else {
                destParent.insertBefore(srcCard, destCard);
              }
            }
            this.commands.sort((a, b) => ids.indexOf(a.id) - ids.indexOf(b.id));
          }
        }
      });
    });
  }

  async importConfig() {
    const selected = await open({
      filters: [{ name: 'JSON', extensions: ['json'] }],
      multiple: false,
    });
    if (selected) {
      try {
        const count = await invoke('import_config', { path: selected, merge: true });
        this.showToast(`📥 Imported ${count} commands`);
        this.loadCommands();
      } catch (err) {
        this.showToast(`Import error: ${err}`);
      }
    }
  }

  async exportConfig() {
    const path = await save({ defaultPath: 'command_runner_export.json' });
    if (path) {
      try {
        const count = await invoke('export_config', { path });
        this.showToast(`📤 Exported ${count} commands`);
      } catch (err) {
        this.showToast(`Export error: ${err}`);
      }
    }
  }

  showToast(msg) {
    const container = document.getElementById('toast-container');
    const toast = document.createElement('div');
    toast.className = 'toast';
    toast.textContent = msg;
    container.appendChild(toast);
    setTimeout(() => {
      toast.style.opacity = '0';
      setTimeout(() => toast.remove(), 200);
    }, 2500);
  }

  closeModal(modal) { modal.classList.add('hidden'); }
  closeAllModals() {
    [this.modalCommand, this.modalVar, this.modalConfirm].forEach(m => m.classList.add('hidden'));
  }
}

document.addEventListener('DOMContentLoaded', () => {
  new CommandRunnerApp();
});
