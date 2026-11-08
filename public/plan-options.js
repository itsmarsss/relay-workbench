import { e, prose } from './ui.js';
export function planOptions(options = []) {
  return options
    .map(
      (option, index) =>
        `<article class="approach-option"><input id="approach-${index}" type="radio" name="optionId" value="${e(option.id)}" ${index === 0 ? 'checked' : ''}><div class="approach-content"><label class="approach-title" for="approach-${index}">${e(option.title.replace(/\s*\(recommended\)\s*$/i, ''))}${index === 0 ? '<em>Recommended</em>' : ''}</label><div class="prose approach-description">${prose(option.description)}</div>${option.tradeoffs ? `<div class="approach-tradeoffs"><span>Tradeoffs</span><div class="prose">${prose(option.tradeoffs)}</div></div>` : ''}</div></article>`,
    )
    .join('');
}
