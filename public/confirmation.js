import { e } from './ui.js';
export function confirmation({
  subject = '',
  description,
  details = '',
  cancel = 'Cancel',
  confirm,
  action,
  cancelAttributes = 'data-action="close-modal"',
  attributes = '',
  tone = 'danger',
}) {
  return `<div class="confirmation-content">${subject ? `<p class="confirmation-subject">${e(subject)}</p>` : ''}<p class="modal-description">${e(description)}</p>${details}</div><div class="modal-footer confirmation-actions"><button type="button" class="btn secondary" ${cancelAttributes}>${e(cancel)}</button><button type="button" class="btn ${e(tone)}" data-action="${e(action)}" ${attributes}>${e(confirm)}</button></div>`;
}
