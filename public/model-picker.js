import { e } from './ui.js';
export function modelPicker({
  id,
  name = 'model',
  provider,
  value = '',
  catalog = {},
  known = [],
  disabled = false,
  defaultLabel = 'Provider default',
}) {
  const choices = new Map((catalog[provider]?.models ?? []).map((model) => [model.id, model.name]));
  for (const model of [...known, value].filter(Boolean))
    if (!choices.has(model)) choices.set(model, model);
  return `<select class="input" ${id ? `id="${e(id)}"` : ''} name="${e(name)}" data-allow-custom data-model-provider="${e(provider)}" ${disabled ? 'disabled' : ''}><option value="">${e(defaultLabel)}</option>${[...choices].map(([model, label]) => `<option value="${e(model)}" ${model === value ? 'selected' : ''}>${e(label === model ? model : `${label} · ${model}`)}</option>`).join('')}</select>`;
}
export function modelCatalogHint(catalog, provider) {
  const entry = catalog[provider];
  if (!entry) return 'Loading available models…';
  if (entry.status === 'unavailable')
    return entry.models?.length
      ? 'Using the last model list. Refresh to retry.'
      : 'Couldn’t load models. Refresh or enter a custom ID in search.';
  if (!entry.models?.length) return 'No models reported. Enter a custom ID in search.';
  return `${entry.models.length} available models · search or enter a custom ID`;
}
