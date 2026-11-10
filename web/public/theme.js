// Apply local appearance before paint; all assets remain available offline.
try {
  const theme = localStorage.getItem('relay-theme') || 'system';
  document.documentElement.dataset.theme =
    theme === 'dark' || (theme === 'system' && matchMedia('(prefers-color-scheme: dark)').matches)
      ? 'dark'
      : 'light';
  document.documentElement.dataset.lowMotion = String(
    localStorage.getItem('relay-low-motion') === 'true',
  );
} catch {}
