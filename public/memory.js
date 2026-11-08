import { runLabel } from './run-label.js';
import { harnessName } from './run-presentation.js';
import { taskRuns } from './task-runs.js';
import { e } from './ui.js';

function scopeLabel(memory, config, tasks) {
  if (memory.scope === 'global') return 'Global';
  const name =
    memory.scope === 'project'
      ? config.repositories.find((r) => r.id === memory.targetId)?.name
      : tasks.find((t) => t.id === memory.targetId)?.title;
  return `${memory.scope === 'project' ? 'Project' : 'Task'} · ${name || memory.targetId}`;
}
function stateLabel(memory) {
  if (memory.status === 'proposed') return 'Needs approval';
  if (memory.status === 'disabled') return 'Disabled';
  if (memory.expiresAt && Date.parse(memory.expiresAt) <= Date.now()) return 'Expired';
  return 'Active';
}
export function memoryPage(memories, config, tasks, { query = '', filter = 'all' } = {}) {
  const shown = memories.filter(
    (m) =>
      (filter === 'all' ||
        (filter === 'proposed' ? m.status === 'proposed' : m.scope === filter)) &&
      `${m.title} ${m.content} ${scopeLabel(m, config, tasks)}`
        .toLowerCase()
        .includes(query.toLowerCase()),
  );
  const proposed = memories.filter((m) => m.status === 'proposed').length;
  return `<div class="page-heading"><div><span class="eyebrow">CONTEXT THAT LASTS</span><h1>Memory</h1><p>Preferences and context for future runs.</p></div><button class="btn primary" data-action="new-memory">Add memory</button></div><details class="memory-guide"><summary>How memory works</summary><p>Task direction comes first, then task, project, and global memory. Agent suggestions need approval. Changes apply to future runs.</p></details><div class="memory-toolbar"><label>Search<input class="input" id="memory-search" type="search" placeholder="Find a preference or observation" value="${e(query)}"></label><label>Show<select class="input" id="memory-filter"><option value="all">All memories</option>${[
    ['proposed', `Needs approval (${proposed})`],
    ['global', 'Global'],
    ['project', 'Project'],
    ['task', 'Task'],
  ]
    .map(
      ([value, label]) =>
        `<option value="${value}" ${value === filter ? 'selected' : ''}>${label}</option>`,
    )
    .join(
      '',
    )}</select></label><button class="btn secondary" data-action="export-memories">Export JSON</button></div><div class="memory-list">${shown.length ? shown.map((m) => `<article class="memory-card" data-event-key="memory-${e(m.id)}"><div class="memory-card-heading"><div><div class="memory-meta"><span>${e(scopeLabel(m, config, tasks))}</span><span>${m.kind === 'preference' ? 'Preference' : 'Observation'}</span><span class="memory-state ${m.status === 'proposed' ? 'pending' : ''}">${stateLabel(m)}</span></div><h2>${e(m.title)}</h2></div><span class="memory-version">v${m.revision}</span></div><p class="memory-content">${e(m.content)}</p><div class="memory-provenance">${m.source.type === 'agent' ? `Suggested by ${e(m.source.harness)}${m.source.model ? ` (${e(m.source.model)})` : ''} · <a href="#task/${e(m.source.taskId)}/handoffs">Source run</a>` : 'Added by you'} · Updated ${e(new Date(m.updatedAt).toLocaleDateString())}${m.approvedAt ? ` · Approved ${e(new Date(m.approvedAt).toLocaleDateString())}` : ''}${m.expiresAt ? ` · Expires ${e(new Date(m.expiresAt).toLocaleString())}` : ''}</div>${m.evidence ? `<details class="report-section"><summary>Source & evidence</summary><p class="memory-content">${e(m.evidence)}</p></details>` : ''}<div class="memory-actions">${m.status === 'proposed' ? `<button class="btn primary small" data-action="approve-memory" data-memory="${e(m.id)}">Approve</button>` : ''}<button class="btn secondary small" data-action="edit-memory" data-memory="${e(m.id)}">Edit</button>${m.status !== 'proposed' ? `<button class="btn text small" data-action="toggle-memory" data-memory="${e(m.id)}">${m.status === 'disabled' ? 'Enable' : 'Disable'}</button>` : ''}<button class="btn text small" data-action="delete-memory" data-memory="${e(m.id)}">${m.status === 'proposed' ? 'Reject' : 'Delete'}</button></div></article>`).join('') : `<div class="panel-empty"><h2>${memories.length ? 'No matching memories' : 'Nothing remembered yet'}</h2><p>Add a preference once and Relay will include it in relevant future runs.</p></div>`}</div>`;
}
export function memoryForm(memory, config, tasks, defaults = {}) {
  const value = {
    scope: 'global',
    targetId: '',
    kind: 'preference',
    status: 'active',
    ...defaults,
    ...memory,
  };
  const selected = value.scope === 'global' ? 'global' : `${value.scope}:${value.targetId}`;
  return `<form id="memory-form"><p class="memory-form-note">Give future agents a preference or useful context.</p><label class="field-label" for="memory-title">Title</label><input class="input" id="memory-title" name="title" maxlength="120" value="${e(value.title || '')}" required><div class="memory-form-grid"><label>Applies to<select class="input" name="scopeTarget"><option value="global" ${selected === 'global' ? 'selected' : ''}>Global · all projects</option><optgroup label="Projects">${config.repositories.map((r) => `<option value="project:${e(r.id)}" ${selected === `project:${r.id}` ? 'selected' : ''}>${e(r.name)}</option>`).join('')}</optgroup><optgroup label="Tasks">${tasks.map((t) => `<option value="task:${e(t.id)}" ${selected === `task:${t.id}` ? 'selected' : ''}>${e(t.title)}</option>`).join('')}</optgroup></select></label><label>Type<select class="input" name="kind"><option value="preference" ${value.kind === 'preference' ? 'selected' : ''}>Preference</option><option value="observation" ${value.kind === 'observation' ? 'selected' : ''}>Observation</option></select></label></div><label class="field-label" for="memory-content">Memory</label><textarea class="input" id="memory-content" name="content" rows="4" maxlength="2000" required>${e(value.content || '')}</textarea><label class="field-label" for="memory-evidence">Source or evidence <small>Optional</small></label><textarea class="input" id="memory-evidence" name="evidence" rows="2" maxlength="2000">${e(value.evidence || '')}</textarea><details class="memory-advanced" ${value.expiresAt || value.status !== 'active' ? 'open' : ''}><summary>Advanced settings</summary><div class="memory-form-grid"><label>Expires at (UTC)<input class="input" id="memory-expiry" name="expiresAt" type="datetime-local" value="${e(value.expiresAt?.slice(0, 16) || '')}"><small>Useful for environment observations.</small></label><label>Status<select class="input" name="status">${[
    ['active', 'Active · approved by you'],
    ['disabled', 'Disabled'],
    ['proposed', 'Needs approval'],
  ]
    .map(
      ([id, name]) =>
        `<option value="${id}" ${id === value.status ? 'selected' : ''}>${name}</option>`,
    )
    .join(
      '',
    )}</select></label></div></details><div class="modal-footer"><small class="memory-form-note">Active memories are approved for future runs.</small><button class="btn secondary" type="button" data-action="close-modal">Cancel</button><button class="btn primary" type="submit">Save memory</button></div></form>`;
}
export function runMemories(task) {
  const runs = taskRuns(task).filter((a) => a.memorySnapshot),
    latest = runs.at(-1);
  const entries = latest?.memorySnapshot.entries ?? [];
  return `<section class="context-card task-memory-card"><div class="context-title">MEMORY <span>${entries.length} in latest run</span></div>${
    entries.length
      ? `<ul class="memory-compact-list">${entries
          .slice(0, 3)
          .map(
            (m) =>
              `<li>${e(m.title)}<small>${e(m.scope.charAt(0).toUpperCase() + m.scope.slice(1))}</small></li>`,
          )
          .join(
            '',
          )}</ul>${entries.length > 3 ? `<small>${entries.length - 3} more included</small>` : ''}`
      : '<p>No memories included in the latest run.</p>'
  }<div class="memory-compact-actions"><button class="btn text small" data-action="task-memory">Add memory</button><button class="btn text small" data-action="memory-history">View run history (${runs.length})</button></div></section>`;
}
export function memoryRunHistory(task, selectedId) {
  const runs = taskRuns(task)
    .filter((run) => run.memorySnapshot)
    .slice()
    .reverse();
  const selected = runs.find((run) => run.id === selectedId) ?? runs[0];
  const count = (n) => `${n} ${n === 1 ? 'memory' : 'memories'}`;
  return `<div class="memory-history"><nav aria-label="Memory run history">${runs.map((run, index) => `<button class="memory-history-run ${run.id === selected?.id ? 'selected' : ''}" data-action="memory-select-run" data-id="${e(run.id)}" aria-current="${run.id === selected?.id ? 'true' : 'false'}"><strong>${e(runLabel(run))}</strong><span>${e(harnessName(run.harness))}<span>${count(run.memorySnapshot.entries.length)}</span></span><small>${index === 0 ? 'Latest · ' : ''}${e(new Date(run.startedAt).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }))}</small></button>`).join('') || '<p class="detail-muted">No run snapshots yet.</p>'}</nav><section class="memory-history-content" aria-label="Selected run memory">${selected ? `<header><h3>Memory used</h3><p>${e(runLabel(selected))} · ${e(harnessName(selected.harness))}</p></header>${selected.memorySnapshot.entries.map((memory) => `<article class="memory-run-entry"><div class="memory-entry-heading"><strong>${e(memory.title)}</strong><span>${e(memory.scope)} · v${memory.revision}</span></div><p>${e(memory.content)}</p>${memory.evidence ? `<details class="memory-entry-evidence"><summary>Source</summary><p>${e(memory.evidence)}</p></details>` : ''}</article>`).join('') || '<p class="detail-muted">No active memories were included.</p>'}${selected.memorySnapshot.omitted ? `<p class="detail-muted">${selected.memorySnapshot.omitted} memories omitted to keep context bounded.</p>` : ''}` : ''}</section></div>`;
}

export function answerMemories(snapshot) {
  if (!snapshot) return '';
  return `<details class="report-section"><summary>Memory used by this answer <span>${snapshot.entries.length}</span></summary>${snapshot.entries.map((m) => `<div class="memory-run-entry"><strong>${e(m.title)} <small>v${m.revision} · ${e(m.scope)}</small></strong><p>${e(m.content)}</p></div>`).join('') || '<p>No active memories were included.</p>'}${snapshot.omitted ? `<p>${snapshot.omitted} memories omitted to keep context bounded.</p>` : ''}</details>`;
}
