import { workflowPresets } from './workflow-insights.js';
import { e, stageNames } from './ui.js';
import { markdownEditor } from './markdown.js';
const commands = (values) =>
  (values ?? []).map((value) => JSON.stringify([value.command, ...value.args])).join('\n');
export function taskProfiles(task, config) {
  const profiles = new Map(config.repositories.map((profile) => [profile.id, profile]));
  for (const entry of task?.repositories?.length > 1
    ? task.repositories
    : task && !task.demo
      ? [task]
      : [])
    profiles.set(entry.repository.id, entry.repository);
  return [...profiles.values()];
}
export function taskForm(task, config, { duplicate = false } = {}) {
  const editing = task && !duplicate;
  const started =
    editing &&
    (task.status !== 'draft' || task.attempts?.length || task.workspace || task.baseCommit);
  const prefix = editing ? 'edit' : 'new';
  const profiles = taskProfiles(task, config);
  const entries =
    task?.repositories?.length > 1 ? task.repositories : task && !task.demo ? [task] : [];
  const selected = entries.map((entry) => entry.repository.id);
  const primary = selected.includes(task?.repository.id)
    ? task.repository.id
    : (profiles[0]?.id ?? '');
  const route = task?.routing ?? config.routing;
  const execution = task?.execution ?? config;
  return `<form id="${editing ? 'edit' : 'create'}-task-form" data-task-editor><p class="modal-description">${started ? 'Repository identity and setup are fixed after starting. Requirement or guidance changes pause the task and require a fresh proposal; check changes rerun verification and review. Your worktree and history are preserved.' : 'Configure this task independently of repository defaults. You can revise everything here before starting.'}</p><label class="field-label" for="${prefix}-preset">Workflow</label><select class="input" id="${prefix}-preset" name="preset" ${started ? 'disabled' : ''}><option value="">Custom workflow</option>${workflowPresets.map((p) => `<option value="${p.id}" ${task?.preset === p.id ? 'selected' : ''}>${e(p.title)} — ${e(p.description)}</option>`).join('')}</select><label class="field-label" for="${prefix}-title">Task title</label><input class="input" id="${prefix}-title" name="title" value="${e(duplicate ? `${task.title} (copy)` : (task?.title ?? ''))}" maxlength="240" required><label class="field-label" for="${prefix}-ticket">Source issue</label><div class="input-with-button"><input class="input" id="${prefix}-ticket" name="ticket" value="${e(task?.ticket ?? '')}" placeholder="Issue URL or number"><button type="button" class="btn secondary small" data-action="import-ticket">Import</button></div>${markdownEditor({ id: `${prefix}-description`, name: 'description', label: 'Description & acceptance criteria', value: task?.description ?? '' })}<fieldset class="task-editor-section"><legend>Repositories & implementation order</legend><label class="field-label" for="${prefix}-repository">Primary repository</label><select class="input" id="${prefix}-repository" name="repositoryId" ${started ? 'disabled' : 'required'}>${!profiles.length ? '<option value="">Connect a repository first</option>' : ''}${profiles.map((profile) => `<option value="${e(profile.id)}" ${profile.id === primary ? 'selected' : ''}>${e(profile.name)}</option>`).join('')}</select><details class="advanced-fields" ${selected.length > 1 ? 'open' : ''}><summary>Coordinate additional repositories</summary>${profiles
    .map(
      (profile) =>
        `<div class="repo-participant"><label class="toggle-label"><input type="checkbox" name="additionalRepository" value="${e(profile.id)}" ${selected.includes(profile.id) && profile.id !== primary ? 'checked' : ''} ${started ? 'disabled' : ''}> ${e(profile.name)}</label><label class="field-label">Implement after <select class="input" multiple name="depends-${e(profile.id)}" aria-label="Prerequisites for ${e(profile.name)}" ${started ? 'disabled' : ''}>${profiles
          .filter((other) => other.id !== profile.id)
          .map(
            (other) =>
              `<option value="${e(other.id)}" ${(task?.dependencies ?? []).some((edge) => edge.repositoryId === profile.id && edge.dependsOn === other.id) ? 'selected' : ''}>${e(other.name)}</option>`,
          )
          .join('')}</select></label></div>`,
    )
    .join(
      '',
    )}<p class="form-help">Selected repositories share one plan and approval gates. Prerequisites determine implementation order.</p></details></fieldset><fieldset class="task-editor-section"><legend>Specialists & models</legend><label class="toggle-label"><input type="checkbox" name="smartRouting" ${task?.smartRouting ? 'checked' : ''}> Let triage recommend specialist routing</label><p class="form-help">Choose a harness for each stage. An empty model uses that harness’s configured default. Smart routing may change harness choices after triage.</p><div class="stage-editor-grid">${Object.keys(
    config.routing,
  )
    .map(
      (stage) =>
        `<div><label class="field-label" for="route-${stage}">${e(stageNames[stage])}</label><select class="input" id="route-${stage}" name="route-${stage}">${['codex', 'claude', 'pi'].map((id) => `<option value="${id}" ${route[stage] === id ? 'selected' : ''}>${id}${config.harnesses[id].enabled ? '' : ' (disabled)'}</option>`).join('')}</select><label class="field-label" for="model-${stage}">Model for ${e(stageNames[stage])}</label><input class="input" id="model-${stage}" name="model-${stage}" value="${e(task?.models?.[stage] ?? '')}" maxlength="200" placeholder="Harness default"></div>`,
    )
    .join(
      '',
    )}</div></fieldset><fieldset class="task-editor-section"><legend>Execution limits</legend><div class="form-columns"><label>Stage budget (minutes)<input class="input" type="number" name="timeoutMinutes" value="${execution.timeoutMinutes}" min="1" max="240" required><small>Progress may extend agent/check execution up to twice this budget.</small></label><label>Maximum repair rounds<input class="input" type="number" name="maxRepairRounds" value="${execution.maxRepairRounds}" min="1" max="10" required></label><label>Automatic blocker recovery attempts<input class="input" type="number" name="maxRecoveryAttempts" value="${execution.maxRecoveryAttempts ?? 2}" min="0" max="5" required></label></div></fieldset><fieldset class="task-editor-section"><legend>Repository settings for this task</legend><p class="form-help">Overrides stay with this task. Shared repository profiles are unchanged.</p>${profiles.map((profile, i) => `<details class="task-repository-settings" data-settings-repository="${e(profile.id)}"><summary>${e(profile.name)} · checks & guidance</summary><p class="form-help wrap">${e(profile.path)} · ${e(profile.strategy)}</p><label class="field-label" for="task-cwd-${i}">Working directory for ${e(profile.name)}</label><input class="input" id="task-cwd-${i}" name="repo-${e(profile.id)}-cwd" value="${e(profile.cwd)}" ${started ? 'disabled' : ''}><label class="field-label" for="task-verification-${i}">Verification for ${e(profile.name)}</label><select class="input" id="task-verification-${i}" name="repo-${e(profile.id)}-verification"><option value="agent" ${profile.verificationMode !== 'commands' ? 'selected' : ''}>Agent discovers and runs checks</option><option value="commands" ${profile.verificationMode === 'commands' ? 'selected' : ''}>Run configured commands</option></select><label class="field-label" for="task-checks-${i}">Verification commands for ${e(profile.name)}</label><textarea class="input mono" id="task-checks-${i}" name="repo-${e(profile.id)}-checks" rows="3">${e(commands(profile.checks))}</textarea><label class="field-label" for="task-setup-${i}">Setup commands for ${e(profile.name)}</label><textarea class="input mono" id="task-setup-${i}" name="repo-${e(profile.id)}-setup" rows="2" ${started ? 'disabled' : ''}>${e(commands(profile.setup))}</textarea><p class="form-help">One JSON argument array per line, such as ["npm", "test"].</p>${markdownEditor({ id: `task-instructions-${i}`, name: `repo-${profile.id}-instructions`, label: `Guidance for ${profile.name}`, value: profile.instructions, rows: 4 })}</details>`).join('')}</fieldset><p class="form-help">Implementation always waits for approach approval. Final acceptance stays with you.</p><div class="modal-footer"><button type="button" class="btn text" data-action="close-modal">Cancel</button><button class="btn primary" type="submit">${editing ? 'Save task settings' : 'Create task'}</button></div></form>`;
}
export function syncTaskForm(form) {
  if (!form?.matches('[data-task-editor]')) return;
  const data = new FormData(form);
  const primary = form.elements.namedItem('repositoryId').value;
  const selected = new Set([primary, ...data.getAll('additionalRepository')]);
  // Disabled topology fields represent an existing task; retain its checked selection.
  for (const input of form.querySelectorAll('[name="additionalRepository"]:checked'))
    selected.add(input.value);
  for (const element of form.querySelectorAll('[data-settings-repository]'))
    element.hidden = !selected.has(element.dataset.settingsRepository);
  for (const select of form.querySelectorAll('select[name^="depends-"]')) {
    const owner = select.name.slice(8);
    for (const option of select.options) {
      if (!select.disabled) {
        option.disabled = !selected.has(owner) || !selected.has(option.value);
        if (option.disabled) option.selected = false;
      }
    }
  }
}
export function readTaskForm(form, config, parseCommands, snapshot) {
  const data = new FormData(form);
  const started =
    snapshot &&
    (snapshot.status !== 'draft' ||
      snapshot.attempts?.length ||
      snapshot.workspace ||
      snapshot.baseCommit);
  const entries =
    snapshot?.repositories?.length > 1
      ? snapshot.repositories
      : snapshot && !snapshot.demo
        ? [snapshot]
        : [];
  const repositoryId = started ? snapshot.repository.id : data.get('repositoryId');
  const repositoryIds = started
    ? entries.map((entry) => entry.repository.id)
    : [...new Set([repositoryId, ...data.getAll('additionalRepository')])];
  const dependencies = started
    ? (snapshot.dependencies ?? [])
    : [...data.entries()]
        .filter(([key, value]) => key.startsWith('depends-') && value)
        .map(([key, value]) => ({ repositoryId: key.slice(8), dependsOn: value }));
  const profiles = taskProfiles(snapshot, config);
  return {
    preset: started ? snapshot.preset : data.get('preset') || null,
    title: data.get('title'),
    description: data.get('description'),
    ticket: data.get('ticket'),
    repositoryId,
    repositoryIds,
    dependencies,
    routing: Object.fromEntries(
      Object.keys(config.routing).map((stage) => [stage, data.get(`route-${stage}`)]),
    ),
    models: Object.fromEntries(
      Object.keys(config.routing).map((stage) => [stage, data.get(`model-${stage}`)]),
    ),
    execution: {
      timeoutMinutes: Number(data.get('timeoutMinutes')),
      maxRepairRounds: Number(data.get('maxRepairRounds')),
      maxRecoveryAttempts: Number(data.get('maxRecoveryAttempts') ?? 2),
    },
    smartRouting: data.has('smartRouting'),
    repositorySettings: repositoryIds.filter(Boolean).map((id) => ({
      id,
      cwd: started ? profiles.find((profile) => profile.id === id).cwd : data.get(`repo-${id}-cwd`),
      verificationMode:
        data.get(`repo-${id}-verification`) ??
        profiles.find((profile) => profile.id === id).verificationMode ??
        'agent',
      checks: parseCommands(data.get(`repo-${id}-checks`) ?? ''),
      setup: started
        ? profiles.find((profile) => profile.id === id).setup
        : parseCommands(data.get(`repo-${id}-setup`) ?? ''),
      instructions: data.get(`repo-${id}-instructions`) ?? '',
    })),
  };
}
