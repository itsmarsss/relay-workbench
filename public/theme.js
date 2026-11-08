(() => {
  const key = 'relay-theme';
  const system = matchMedia('(prefers-color-scheme: dark)');
  let preference = 'system';
  try {
    preference = localStorage.getItem(key) || 'system';
  } catch {}
  function apply() {
    const dark = preference === 'dark' || (preference === 'system' && system.matches);
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.content = dark ? '#18211d' : '#f7f8f6';
  }
  function set(value) {
    preference = ['system', 'light', 'dark'].includes(value) ? value : 'system';
    try {
      localStorage.setItem(key, preference);
    } catch {}
    apply();
  }
  system.addEventListener('change', apply);
  window.addEventListener('storage', (event) => {
    if (event.key === key) {
      preference = event.newValue || 'system';
      apply();
    }
  });
  window.RelayTheme = { set, preference: () => preference };
  apply();
})();
