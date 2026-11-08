import { e, icon } from './ui.js';
import { markdownEditor } from './markdown.js';
const tabs = [
  ['basics', 'General'],
  ['workspace', 'Workspace'],
  ['checks', 'Checks & setup'],
  ['integration', 'Integrations'],
  ['guidance', 'Guidance'],
];
const field = (id, label, content, help = '') =>
  `<div class="profile-field"><label for="${id}">${label}</label>${content}${help ? `<p class="form-help">${help}</p>` : ''}</div>`;
export function repositoryProfileForm(r, id, commandsInput) {
  const command = (name, label, value, help, placeholder = '') =>
    field(
      `repo-${name}`,
      label,
      `<textarea class="input mono" id="repo-${name}" name="${name === 'workspace-command' ? 'workspaceCommand' : name === 'issue' ? 'issueCommand' : name === 'pr' ? 'prCommand' : name}" rows="3" placeholder="${e(placeholder)}">${e(value)}</textarea>`,
      help,
    );
  return `<form id="repository-form" class="repository-profile-form"><p class="profile-intro">${id ? 'Defaults for new tasks. Existing tasks keep their saved configuration.' : 'Connect a local checkout. Each task gets its own worktree by default.'}</p><nav class="profile-tabs" role="tablist" aria-label="Repository profile sections">${tabs.map(([key, label], index) => `<button type="button" id="profile-tab-${key}" role="tab" aria-selected="${index === 0}" aria-controls="profile-panel-${key}" tabindex="${index === 0 ? 0 : -1}" data-profile-tab="${key}">${label}</button>`).join('')}</nav><div class="profile-content"><section id="profile-panel-basics" role="tabpanel" aria-labelledby="profile-tab-basics"><h3>Repository details</h3><p>Give this checkout a recognizable name and choose where agents work.</p>${field('repo-name', 'Name', `<input class="input" id="repo-name" name="name" value="${e(r.name)}" maxlength="100" placeholder="My service" required>`)}${field('repo-path', 'Absolute checkout path', `<input class="input mono" id="repo-path" name="path" value="${e(r.path)}" placeholder="/absolute/path/to/repository" required>`)}${field('repo-cwd', 'Working subdirectory', `<input class="input mono" id="repo-cwd" name="cwd" value="${e(r.cwd)}" placeholder=".">`, 'Use . for the repository root, or a relative path for a package or service.')}<section class="profile-suggestions" aria-label="Repository suggestions"><div class="profile-suggestions-heading"><div><h4>Detect settings</h4><p>Read project metadata for names, packages and commands.</p></div><button type="button" class="btn secondary small" data-profile-detect>Detect</button></div><div data-profile-suggestions aria-live="polite"></div></section></section><section id="profile-panel-workspace" role="tabpanel" aria-labelledby="profile-tab-workspace" hidden><h3>Task workspace</h3><p>Agents share one workspace throughout a task.</p>${field('repo-strategy', 'Workspace strategy', `<select class="input" id="repo-strategy" name="strategy"><option value="worktree" ${r.strategy === 'worktree' ? 'selected' : ''}>New worktree per task</option><option value="managed" ${r.strategy === 'managed' ? 'selected' : ''}>Managed worktree per task</option><option value="attach" ${r.strategy === 'attach' ? 'selected' : ''}>Attach existing checkout</option></select>`)}<p class="profile-strategy-hint" data-strategy-hint></p><div data-managed-fields ${r.strategy !== 'managed' ? 'hidden' : ''}>${command('workspace-command', 'Workspace creation command', r.workspaceCommand ? commandsInput([r.workspaceCommand]) : '', 'One JSON argument array. Must create or reuse a clean checkout at the requested branch and base.', '["workspace-tool","create","{workspaceName}"]')}${field('repo-workspace-path', 'Checkout root template', `<input class="input mono" id="repo-workspace-path" name="workspacePath" value="${e(r.workspacePath || '')}" placeholder="/absolute/workspaces/{workspaceName}">`, 'Placeholders: {workspaceName}, {branch}, {baseCommit}, {taskId}.')}</div></section><section id="profile-panel-checks" role="tabpanel" aria-labelledby="profile-tab-checks" hidden><h3>Verification & setup</h3><p>Let the agent discover checks, or specify your own commands.</p>${field('repo-verification', 'Verification', `<select class="input" id="repo-verification" name="verificationMode"><option value="agent" ${r.verificationMode !== 'commands' ? 'selected' : ''}>Agent discovers and runs checks</option><option value="commands" ${r.verificationMode === 'commands' ? 'selected' : ''}>Run configured commands</option></select>`)}<div data-verification-commands ${r.verificationMode !== 'commands' ? 'hidden' : ''}>${command('checks', 'Verification commands', commandsInput(r.checks), 'One JSON argument array per line. Each command must pass.', '["npm","test"]')}</div><div class="profile-divider">${command('setup', 'Setup commands', commandsInput(r.setup), 'Optional. Runs once when the task workspace is created. One JSON argument array per line.', '["npm","ci"]')}</div></section><section id="profile-panel-integration" role="tabpanel" aria-labelledby="profile-tab-integration" hidden><h3>Provider integrations</h3><p>Optional commands for your issue and code host. Agents can discover publication tooling themselves.</p>${command('issue', 'Issue import command', r.issueCommand ? commandsInput([r.issueCommand]) : '', 'One JSON argument array. Use {ticket} for the issue URL.', '["issue-tool","view","{ticket}"]')}${command('pr', 'Publication command hint', r.prCommand ? commandsInput([r.prCommand]) : '', 'Optional hint for the publication agent. One noninteractive JSON argument array.')}<p class="form-help">Integration details stay local to this Relay installation.</p></section><section id="profile-panel-guidance" role="tabpanel" aria-labelledby="profile-tab-guidance" hidden><h3>Agent guidance</h3><p>Additional instructions for tasks using this profile.</p>${markdownEditor({ id: 'repo-instructions', name: 'instructions', label: 'Workflow instructions', value: r.instructions || '', rows: 8, max: 20000 })}</section></div><div class="profile-remove-confirm" hidden><strong>Remove this repository profile?</strong><p>Existing tasks and worktrees are kept. You can add this checkout again.</p><button class="btn secondary small" type="button" data-profile-keep>Keep profile</button><button class="btn danger small" type="button" data-action="delete-repository" data-id="${e(id || '')}">Remove profile</button></div><footer class="modal-footer profile-footer"><div>${id ? '<button class="btn text small profile-remove" type="button" data-profile-remove>Remove profile</button>' : '<span class="profile-save-hint">Saved on this machine</span>'}</div><div><button class="btn text" type="button" data-action="close-modal">Cancel</button><button class="btn primary" type="submit">Save repository ${icon('check')}</button></div></footer></form>`;
}
function activate(form, key, focus = false) {
  for (const tab of form.querySelectorAll('[data-profile-tab]')) {
    const active = tab.dataset.profileTab === key;
    tab.setAttribute('aria-selected', String(active));
    tab.tabIndex = active ? 0 : -1;
    if (active && focus) tab.focus();
  }
  for (const panel of form.querySelectorAll('.profile-content > section[role=tabpanel]'))
    panel.hidden = panel.id !== `profile-panel-${key}`;
}
export function syncRepositoryProfile(form) {
  if (!form) return;
  const strategy = form.elements.strategy.value;
  form.querySelector('[data-managed-fields]').hidden = strategy !== 'managed';
  form.querySelector('[data-strategy-hint]').textContent = {
    worktree: 'Creates an isolated branch and worktree for each task.',
    managed: 'Uses your workspace manager to create an isolated checkout.',
    attach: 'Uses the existing checkout and branch. It must be clean when the task starts.',
  }[strategy];
  form.querySelector('[data-verification-commands]').hidden =
    form.elements.verificationMode.value !== 'commands';
}
document.addEventListener('click', (event) => {
  const form = event.target.closest('#repository-form');
  if (!form) return;
  const tab = event.target.closest('[data-profile-tab]');
  if (tab) activate(form, tab.dataset.profileTab);
  if (event.target.closest('[data-profile-remove]')) {
    const panel = form.querySelector('.profile-remove-confirm');
    panel.hidden = false;
    panel.scrollIntoView({ block: 'nearest' });
    panel.querySelector('[data-profile-keep]').focus();
  }
  if (event.target.closest('[data-profile-keep]')) {
    form.querySelector('.profile-remove-confirm').hidden = true;
    form.querySelector('[data-profile-remove]').focus();
  }
});
document.addEventListener('change', (event) => {
  if (event.target.matches('#repo-strategy,#repo-verification'))
    syncRepositoryProfile(event.target.form);
});
document.addEventListener(
  'invalid',
  (event) => {
    const panel = event.target.closest('#repository-form [role=tabpanel]');
    if (panel) activate(event.target.form, panel.id.replace('profile-panel-', ''));
  },
  true,
);
document.addEventListener('keydown', (event) => {
  if (
    !event.target.matches('[data-profile-tab]') ||
    !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)
  )
    return;
  event.preventDefault();
  const index = tabs.findIndex(([key]) => key === event.target.dataset.profileTab);
  const next =
    event.key === 'Home'
      ? 0
      : event.key === 'End'
        ? tabs.length - 1
        : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
  activate(event.target.closest('form'), tabs[next][0], true);
});
