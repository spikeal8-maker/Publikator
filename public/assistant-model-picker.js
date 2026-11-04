/**
 * Live provider model picker. A successful model-list request proves only that
 * discovery works. Tool-use readiness is verified separately by the saved
 * connection's harmless publikator_connection_probe.
 */
export function createModelPicker({api, getConnections, getEditId}) {
  const $ = id => document.getElementById(id);
  let serial = 0, timer = null, last = [], currentModel = '';
  const kind = () => $('provider-kind').value;
  const url = () => $('provider-url').value.trim();
  const key = () => $('provider-key').value.trim();
  const oldConnection = () => getConnections().find(x => x.id === getEditId());
  const message = (text, level='') => {
    $('models-status').textContent = text;
    $('models-status').className = 'models-status ' + level;
  };
  function setOptions(models, selected = '') {
    const select = $('provider-model');
    select.replaceChildren(new Option('Выберите модель', ''));
    for (const m of models) {
      const description = [
        m.label && m.label !== m.id ? m.label : m.id,
        m.parameterSize,
        m.cloud ? 'облачная модель Ollama' : null,
        m.contextWindow ? 'контекст ' + Intl.NumberFormat('ru-RU').format(m.contextWindow) : null
      ].filter(Boolean).join(' · ');
      select.add(new Option(description, m.id));
    }
    if (selected && !models.some(m => m.id === selected)) {
      select.add(new Option(selected + ' (сохранённая модель, не обнаружена)', selected));
    }
    select.value = selected || '';
    currentModel = select.value;
    last = models;
  }
  function compatibleSavedKey() {
    const existing = oldConnection();
    return Boolean(existing?.hasKey && existing.provider === kind() &&
      existing.baseUrl.replace(/\/$/, '') === url().replace(/\/$/, ''));
  }
  function canQuery(showReason = true) {
    if (!url()) { if (showReason) message('Введите адрес сервера API.', 'info'); return false; }
    if (kind() !== 'ollama' && !key() && !compatibleSavedKey()) {
      if (showReason) message('Для ' + $('provider-kind').selectedOptions[0].text +
        ' нужен API-ключ. Укажите его, и список моделей загрузится автоматически.', 'info');
      return false;
    }
    return true;
  }
  function selected() {
    return $('provider-manual-model').value.trim() || $('provider-model').value || '';
  }
  function providerHint() {
    const p=kind();
    const hostHint=p === 'ollama'
      ? 'Ollama на этом компьютере: http://host.docker.internal:11434. На другом компьютере в локальной сети: http://IP-компьютера:11434. Сервер Ollama должен разрешать подключения по сети.'
      : p === 'deepseek' ? 'DeepSeek: используется ваш ключ API. Доступные именно ему модели определяются запросом к DeepSeek.'
      : p === 'openai' ? 'OpenAI: используется отдельный API-ключ OpenAI, не подписка ChatGPT. Список моделей приходит из API.'
      : 'Совместимый HTTPS API: провайдер должен поддерживать GET /models и вызов инструментов.';
    $('provider-guide').textContent = hostHint;
    $('provider-key').required = p !== 'ollama' && !compatibleSavedKey();
    $('provider-key-row').hidden = false;
    $('provider-key').placeholder = p === 'ollama' ? 'Для Ollama необязательно' : (compatibleSavedKey() ? 'Ключ сохранён, при необходимости замените' : 'Введите API-ключ');
  }
  async function discover({quiet = false} = {}) {
    const id = ++serial;
    if (!canQuery(true)) { setOptions([], currentModel); return []; }
    const existing = oldConnection();
    const body = {
      provider:kind(), baseUrl:url(), apiKey:key(),
      ...(existing?.id ? {id:existing.id} : {})
    };
    message('Получаю установленные и доступные модели…', 'pending');
    $('load-models').disabled = true;
    try {
      const response = await api('/api/assistant/discover-models',
        {method:'POST', body:JSON.stringify(body)});
      if (id !== serial) return [];
      const details = Array.isArray(response.modelDetails) ? response.modelDetails :
        response.models.map(name=>({id:name,label:name,cloud:false}));
      const previouslySelected = selected();
      const candidate = details.some(x=>x.id === previouslySelected) ?
        previouslySelected : (response.suggestedModel || details[0]?.id || '');
      setOptions(details, candidate);
      message('Найдено моделей: ' + details.length +
        (candidate ? '. Выбрана: ' + candidate + '. Для проверки публикационных инструментов сохраните подключение.' : '.'),
        details.length ? 'ok' : 'info');
      if (!quiet && !details.length) throw new Error('Провайдер не вернул доступных моделей.');
      return details;
    } catch(error) {
      if (id === serial) {
        const reason = error instanceof Error ? error.message : 'Ошибка соединения';
        message('Не удалось получить список: ' + reason, 'error');
        if (!quiet) throw error;
      }
      return [];
    } finally {
      if (id === serial) $('load-models').disabled = false;
    }
  }
  function cancel() { ++serial; if (timer) clearTimeout(timer); timer = null; $('load-models').disabled = false; }
  function schedule() {
    cancel();
    if (!canQuery(true)) return;
    timer = setTimeout(() => { timer=null; void discover({quiet:true}); }, 400);
  }
  function selectExisting(c) {
    cancel();
    $('provider-manual-model').value = '';
    currentModel = c?.model || '';
    setOptions([], currentModel);
    providerHint();
    if (canQuery(false)) schedule();
    else canQuery(true);
    $('provider-test-result').textContent = c?.toolVerified
      ? 'Ранее проверено: модель умеет вызывать инструменты.' : c
      ? 'Подключение сохранено, вызовы инструментов ещё не проверены.' : '';
    $('provider-test-result').className = 'test-result ' + (c?.toolVerified ? 'ok' : '');
  }
  function onProviderChange() {
    cancel();
    $('provider-manual-model').value='';
    setOptions([], '');
    providerHint();
    schedule();
  }
  return {discover, schedule, cancel, selectExisting, onProviderChange,
    selected, providerHint, canQuery, message};
}
