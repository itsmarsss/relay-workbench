// Apply local appearance before paint; all assets remain available offline.
try {
  document.documentElement.dataset.theme =
    localStorage.getItem('relay-theme') === 'dark' ? 'dark' : 'light';
  document.documentElement.dataset.lowMotion = String(
    localStorage.getItem('relay-low-motion') === 'true',
  );
} catch {}
