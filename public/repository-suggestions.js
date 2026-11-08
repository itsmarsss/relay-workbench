import { e } from './ui.js';
export function installRepositorySuggestions(form, { api, notify }) {
  const output = form.querySelector('[data-profile-suggestions]');
  const button = form.querySelector('[data-profile-detect]');
  if (!output || !button) return;
  let revision = 0,
    result = null,
    pendingSignature = null,
    loadedSignature = null;
  const signature = () =>
    JSON.stringify([form.elements.path.value.trim(), form.elements.cwd.value.trim() || '.']);
  const render = () => {
    output.innerHTML = `${result.guidance?.length ? `<p class="profile-detected-guidance">Guidance found: ${result.guidance.map((file) => `<code>${e(file)}</code>`).join(' ')}</p>` : ''}<ul>${result.suggestions.map((item, index) => `<li><div><strong>${e(item.label)}</strong><code>${e(typeof item.value === 'object' ? JSON.stringify([item.value.command, ...item.value.args]) : item.value)}</code><small>${e(item.evidence)}</small></div><button type="button" class="btn text small" data-use-suggestion="${index}">${item.field === 'checks' ? 'Add check' : item.field === 'setup' ? 'Add setup' : 'Use'}</button></li>`).join('')}</ul><p class="form-help">Optional suggestions from metadata. Adding a check switches verification to explicit commands. Follow repository guidance before running them.</p>`;
  };
  const load = async (force = false) => {
    const path = form.elements.path.value.trim();
    if (!path) {
      output.innerHTML = '<p class="form-help">Enter a checkout path first.</p>';
      return;
    }
    const inputs = signature();
    if (pendingSignature === inputs || (!force && loadedSignature === inputs && result)) return;
    pendingSignature = inputs;
    const current = ++revision;
    button.disabled = true;
    button.textContent = 'Detecting…';
    output.innerHTML = '<p class="form-help" role="status">Reading repository metadata…</p>';
    try {
      const data = await api(
        '/repositories/suggestions',
        'POST',
        { path, cwd: form.elements.cwd.value.trim() || '.' },
        { timeoutMs: 15000 },
      );
      if (!form.isConnected || current !== revision || inputs !== signature()) return;
      result = data;
      loadedSignature = inputs;
      const name = data.suggestions.find((item) => item.field === 'name');
      if (name && !form.elements.name.value.trim()) form.elements.name.value = name.value;
      render();
    } catch (error) {
      if (form.isConnected && current === revision)
        output.innerHTML = `<p class="profile-detection-error" role="alert">${e(error.message)}</p><p class="form-help">You can still configure every field manually.</p>`;
    } finally {
      if (form.isConnected && current === revision) {
        pendingSignature = null;
        button.disabled = false;
        button.textContent = 'Detect';
      }
    }
  };
  button.addEventListener('click', () => load(true));
  form.addEventListener('focusout', (event) => {
    if (event.target.matches('#repo-path,#repo-cwd')) load();
  });
  form.addEventListener('input', (event) => {
    if (event.target.matches('#repo-path,#repo-cwd')) {
      revision++;
      pendingSignature = null;
      result = null;
      button.disabled = false;
      button.textContent = 'Detect';
      output.innerHTML = '<p class="form-help">Path changed. Detect settings for this folder.</p>';
    }
  });
  output.addEventListener('click', (event) => {
    const selected = event.target.closest('[data-use-suggestion]');
    const item = result?.suggestions[Number(selected?.dataset.useSuggestion)];
    if (!selected || !item) return;
    try {
      if (['checks', 'setup'].includes(item.field)) {
        const input = form.elements[item.field];
        const existing = input.value.trim()
          ? input.value
              .trim()
              .split('\n')
              .filter(Boolean)
              .map((line) => JSON.parse(line))
          : [];
        if (
          !existing.every(
            (command) =>
              Array.isArray(command) && command.every((part) => typeof part === 'string'),
          )
        )
          throw Error('Fix the existing command JSON before adding a suggestion.');
        const command = [item.value.command, ...item.value.args];
        if (!existing.some((value) => JSON.stringify(value) === JSON.stringify(command)))
          existing.push(command);
        input.value = existing.map((value) => JSON.stringify(value)).join('\n');
        if (item.field === 'checks') {
          form.elements.verificationMode.value = 'commands';
          form.elements.verificationMode.dispatchEvent(new Event('change', { bubbles: true }));
        }
        form.querySelector('[data-profile-tab=checks]').click();
        input.focus();
        notify(
          item.field === 'checks'
            ? 'Check added. Verification uses configured commands.'
            : 'Setup command added.',
        );
      } else if (['name', 'path', 'cwd'].includes(item.field)) {
        form.elements[item.field].value = item.value;
        notify(`${item.label} applied.`);
        if (item.field === 'path') {
          form.elements.cwd.value = result.cwd;
          load();
        } else if (item.field === 'cwd') {
          form.elements.path.value = result.root;
          load();
        }
      }
    } catch (error) {
      notify(error.message, true);
    }
  });
  if (form.elements.path.value.trim()) load();
}
