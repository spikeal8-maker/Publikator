const quickRouteTitle = document.querySelector('#page-title');
const quickRouteApp = document.querySelector('#app');

function syncQuickRoute() {
  if (!quickRouteTitle || !quickRouteApp || quickRouteApp.classList.contains('hidden')) return;
  const dashboardNav = document.querySelector('.nav[data-view="dashboard"]');
  if (dashboardNav?.classList.contains('active') && quickRouteTitle.textContent?.trim() === 'Обзор') {
    quickRouteTitle.textContent = 'Старт';
  }
}

const quickRouteObserver = new MutationObserver(syncQuickRoute);
if (quickRouteTitle) quickRouteObserver.observe(quickRouteTitle, { childList: true, subtree: true, characterData: true });
if (quickRouteApp) quickRouteObserver.observe(quickRouteApp, { attributes: true, attributeFilter: ['class'] });
document.addEventListener('click', (event) => {
  const target = event.target instanceof Element ? event.target : null;
  if (target?.closest('.nav[data-view="dashboard"]')) setTimeout(syncQuickRoute, 0);
}, true);
setTimeout(syncQuickRoute, 0);
