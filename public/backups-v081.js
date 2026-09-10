const backupNav = document.querySelector('.nav[data-view="backups"]');

backupNav?.addEventListener('click', async (event) => {
  event.preventDefault();
  event.stopImmediatePropagation();
  document.querySelectorAll('.nav').forEach((item) => item.classList.remove('active'));
  backupNav.classList.add('active');
  const title = document.querySelector('#page-title');
  if (title) title.textContent = 'Резервные копии';
  if (typeof window.PublikatorRenderFullBackups === 'function') {
    await window.PublikatorRenderFullBackups();
    return;
  }
  const view = document.querySelector('#view');
  if (view) view.innerHTML = '<div class="card error">Модуль полного backup не загружен.</div>';
}, true);
