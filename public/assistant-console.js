export function setupAssistantConsole({ api }) {
  const get = (id) => document.getElementById(id);
  const dialog = get('owner-console');
  const output = get('console-output');
  const feedback = get('console-feedback');
  let requestId = 0;

  async function display(url) {
    const run = ++requestId;
    feedback.textContent = 'Выполняется запрос…';
    output.textContent = '';
    try {
      const result = await api(url);
      if (run !== requestId) return;
      output.textContent = JSON.stringify(result, null, 2);
      feedback.textContent = 'Данные получены.';
    } catch (error) {
      if (run === requestId) feedback.textContent = error.message;
    }
  }

  const readStatus = () => display('/api/assistant/console/status');
  get('console-open').addEventListener('click', () => {
    dialog.showModal();
    void readStatus();
  });
  get('console-status').addEventListener('click', readStatus);
  get('console-actions').addEventListener('click', () => display('/api/assistant/actions'));
  dialog.addEventListener('close', () => { requestId++; });
  get('console-change-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const run = ++requestId;
    try {
      const result = await api('/api/assistant/console/change-draft', {
        method: 'POST',
        body: JSON.stringify(Object.fromEntries(new FormData(event.currentTarget))),
      });
      if (run !== requestId) return;
      get('console-change-text').value = result.title + '\n\n' + result.body;
      get('console-change-result').hidden = false;
      feedback.textContent = 'Описание задачи готово.';
    } catch (error) {
      if (run === requestId) feedback.textContent = error.message;
    }
  });
  get('console-copy-change').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(get('console-change-text').value);
      feedback.textContent = 'Текст задачи скопирован.';
    } catch {
      feedback.textContent = 'Системный буфер недоступен. Выделите текст и скопируйте его.';
    }
  });
}
