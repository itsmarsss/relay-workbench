import { e } from './ui.js';
export const followUpModes = {
  question: {
    label: 'Ask',
    help: 'Read-only conversation with the full task context.',
    placeholder: 'Ask about the work, decisions, or PR…',
    submit: 'Ask Relay',
  },
  changes: {
    label: 'Request edits',
    help: 'Plan → approve → edit → verify → review in this workspace.',
    placeholder: 'Describe what you want changed…',
    submit: 'Plan edits',
  },
  publication: {
    label: 'Update PR',
    help: 'Ask the publication agent to update PR details. Source edits use Request edits.',
    placeholder: 'Describe the PR title, description, or metadata update…',
    submit: 'Update PR',
  },
};
export function followUpComposer(task) {
  if (task.status !== 'completed' || task.demo) return '';
  const entries = task.repositories?.length > 1 ? task.repositories : [task];
  const busy = entries.some(
    (entry) => entry.delivery?.status === 'running' || entry.submission?.status === 'running',
  );
  return `<section class="follow-up-panel" aria-label="Continue work"><header><h2>Continue work</h2><p>Keep working with this task’s context.</p></header><form id="follow-up-form"><fieldset class="follow-up-modes"><legend class="sr-only">Follow-up mode</legend>${Object.entries(
    followUpModes,
  )
    .map(
      ([value, mode]) =>
        `<label><input type="radio" name="followup-mode" value="${value}" ${value === 'question' ? 'checked' : ''} ${busy && value !== 'question' ? 'disabled' : ''}><span>${e(mode.label)}</span></label>`,
    )
    .join(
      '',
    )}</fieldset><label class="sr-only" for="follow-up-message">Follow-up request</label><textarea id="follow-up-message" name="message" class="input" rows="3" maxlength="10000" required placeholder="${e(followUpModes.question.placeholder)}"></textarea>${entries.length > 1 ? `<label class="follow-up-repository" hidden>PR repository<select class="input" name="repositoryId">${entries.map((entry) => `<option value="${e(entry.repository.id)}">${e(entry.repository.name)}</option>`).join('')}</select></label>` : ''}<div class="follow-up-footer"><small data-follow-up-help>${e(followUpModes.question.help)}</small><button class="btn primary small" type="submit">Ask Relay</button></div></form></section>`;
}
export function updateFollowUpForm(form) {
  const value = form.querySelector('[name="followup-mode"]:checked')?.value ?? 'question';
  const mode = followUpModes[value];
  form.querySelector('[data-follow-up-help]').textContent = mode.help;
  form.querySelector('textarea').placeholder = mode.placeholder;
  form.querySelector('textarea').maxLength = value === 'question' ? 10000 : 20000;
  form.querySelector('[type="submit"]').textContent = mode.submit;
  const repository = form.querySelector('.follow-up-repository');
  if (repository) repository.hidden = value !== 'publication';
}
