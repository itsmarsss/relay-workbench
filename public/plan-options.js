import { e, prose } from './ui.js';
if (typeof document !== 'undefined')
  document.addEventListener('click', (event) => {
    const card = event.target.closest('.approach-option');
    if (!card || event.target.closest('a,button,input,label') || window.getSelection()?.toString())
      return;
    const radio = card.querySelector('input[type=radio]');
    radio.checked = true;
    radio.dispatchEvent(new Event('change', { bubbles: true }));
  });
export function planOptions(options = [], recommendedOptionId) {
  const selectedId =
    options.find((option) => option.id === recommendedOptionId)?.id ?? options[0]?.id;
  return options
    .map(
      (option, index) =>
        `<article class="approach-option"><input id="approach-${index}" type="radio" name="optionId" value="${e(option.id)}" ${option.id === selectedId ? 'checked' : ''}><div class="approach-content"><label class="approach-title" for="approach-${index}">${e(option.title.replace(/\s*\(recommended\)\s*$/i, ''))}${option.id === recommendedOptionId ? '<em>Recommended</em>' : ''}</label><div class="prose approach-description">${prose(option.description)}</div>${option.tradeoffs ? `<div class="approach-tradeoffs"><span>Tradeoffs</span><div class="prose">${prose(option.tradeoffs)}</div></div>` : ''}</div></article>`,
    )
    .join('');
}
