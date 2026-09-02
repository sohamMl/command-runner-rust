const EMOJI_LIST = [
  '🚀', '💻', '⚡', '🔧', '🛠️', '⚙️', '📦', '🐍', '🦀', '🐳',
  '🐧', '🌐', '🔥', '📊', '📝', '📁', '🗑️', '🔍', '💡', '🧪',
  '🤖', '🛡️', '🔒', '🔑', '🎯', '✨', '🎉', '🍎', '☕', '📈'
];

export function setupEmojiPicker(btnEl, popoverEl, searchEl, gridEl, onSelect) {
  let selected = '🚀';

  function renderGrid(filter = '') {
    gridEl.innerHTML = '';
    const q = filter.toLowerCase().trim();
    const filtered = q ? EMOJI_LIST.filter(e => e.includes(q)) : EMOJI_LIST;

    filtered.forEach(emoji => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = emoji;
      btn.addEventListener('click', () => {
        selected = emoji;
        btnEl.textContent = emoji;
        popoverEl.classList.add('hidden');
        if (onSelect) onSelect(emoji);
      });
      gridEl.appendChild(btn);
    });
  }

  btnEl.addEventListener('click', (e) => {
    e.stopPropagation();
    popoverEl.classList.toggle('hidden');
    if (!popoverEl.classList.contains('hidden')) {
      searchEl.value = '';
      renderGrid();
      searchEl.focus();
    }
  });

  searchEl.addEventListener('input', (e) => renderGrid(e.target.value));

  document.addEventListener('click', (e) => {
    if (!popoverEl.contains(e.target) && e.target !== btnEl) {
      popoverEl.classList.add('hidden');
    }
  });

  renderGrid();
}
