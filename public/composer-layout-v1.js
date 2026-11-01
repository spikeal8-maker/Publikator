// Shared composition for every publication authoring entry point.
export function mountComposerLayout({root, panel, heading, close, editor, preview, layout, footer}) {
  root.classList.add('publication-composer');
  panel.classList.add('composer-panel');
  heading.classList.add('composer-heading');
  close?.classList.add('composer-close');
  layout.classList.add('composer-layout');
  editor.classList.add('composer-fields');
  preview.classList.add('composer-preview');
  layout.append(editor, preview);
  footer?.classList.add('composer-footer');
  root.querySelectorAll('.qc-eyebrow').forEach(node=>node.remove());
  let tabs=root.querySelector('.publication-pane-switch');
  if(!tabs) {
    tabs=document.createElement('div');
    tabs.className='publication-pane-switch';
    layout.before(tabs);
  }
  tabs.classList.add('composer-panes');
  tabs.innerHTML='<button type="button" data-composer-pane="edit" data-pane="edit" aria-pressed="true">Редактировать</button><button type="button" data-composer-pane="preview" data-pane="preview" aria-pressed="false">Предпросмотр</button>';
  layout.dataset.composerPane='edit';
  layout.dataset.pane='edit';
  // Use one pane contract in both create and edit, without nesting editors.
  tabs.querySelectorAll('button').forEach(button=>button.onclick=()=>{
    layout.dataset.composerPane=button.dataset.composerPane;
    layout.dataset.pane=button.dataset.composerPane;
    tabs.querySelectorAll('button').forEach(item=>item.setAttribute('aria-pressed',String(item===button)));
  });
  return {layout};
}

export function mountMediaGuide(host) {
  if(host.querySelector('.composer-media-guide'))return;
  const bar=document.createElement('div');
  bar.className='composer-media-guide';
  bar.innerHTML='<strong>Вложения</strong><span class="composer-media-count" role="status" aria-live="polite">0 / 10 фото</span><details class="composer-help"><summary aria-label="Как добавить фото и видео">i</summary><div><strong>Фото и видео</strong><ol><li>Нажмите «Добавить фото» и выберите сразу несколько файлов. Можно добавлять порциями: до 10 вложений всего — фотографии и MP4 вместе. Меняйте порядок стрелками; ненужные удаляйте.</li><li>Для видеопубликации нажмите «Добавить видео» и выберите один MP4: H.264, звук AAC или без звука. Фотографии можно оставить: они отправятся вместе с роликом.</li><li>Фото и видео отправляются одной публикацией в Telegram, VK и MAX. Стрелками задайте порядок вложений. Обложка ролика создаётся автоматически и не считается второй фотографией.</li><li>Выберите получателей и проверьте полный пост в предпросмотре. Сохранение не отправляет публикацию. Перед отправкой сервер проверит размер, формат и права каждого подключения; общая подсказка не гарантирует доступность формата.</li></ol></div></details>';
  host.prepend(bar);
  const note=document.createElement('p');note.className='composer-media-note';note.setAttribute('role','status');bar.after(note);
}
export function updateMediaGuide(host,{images=0,video=false}={}) {
  mountMediaGuide(host);
  host.querySelector('.composer-media-count').textContent=(images + Number(video)) + ' / 10 вложений';
  host.querySelector('.composer-media-note').textContent=video
    ? images ? images + ' фото + видео · одна публикация' : 'Видео · одна публикация'
    : images ? 'Альбом: '+images+' фото. Можно добавить MP4.' : '';
}
