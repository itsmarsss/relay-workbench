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
  return `<div class="page-heading"><div><span class="eyebrow">CONTEXT THAT LASTS</span><h1>Memory</h1><p>Your preferences and learned context, with a clear source and scope.</p></div><button class="btn primary" data-action="new-memory">Add memory</button></div><section class="memory-guide"><strong>You decide what carries forward.</strong><p>Current task direction comes first, then task, project and global preferences. Observations are evidence to recheck. Agent suggestions need your approval.</p><small>Changes apply to future runs. Running agents retain their recorded context.</small></section><div class="memory-toolbar"><label>Search<input class="input" id="memory-search" type="search" placeholder="Find a preference or observation" value="${e(query)}"></label><label>Show<select class="input" id="memory-filter"><option value="all">All memories</option>${[
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
  return `<form id="memory-form"><p class="memory-form-note">Saving an active memory approves it for future agents. Keep secrets out of memory.</p><label class="field-label" for="memory-title">Title</label><input class="input" id="memory-title" name="title" maxlength="120" value="${e(value.title || '')}" required><div class="memory-form-grid"><label>Applies to<select class="input" name="scopeTarget"><option value="global" ${selected === 'global' ? 'selected' : ''}>Global · all projects</option><optgroup label="Projects">${config.repositories.map((r) => `<option value="project:${e(r.id)}" ${selected === `project:${r.id}` ? 'selected' : ''}>${e(r.name)}</option>`).join('')}</optgroup><optgroup label="Tasks">${tasks.map((t) => `<option value="task:${e(t.id)}" ${selected === `task:${t.id}` ? 'selected' : ''}>${e(t.title)}</option>`).join('')}</optgroup></select></label><label>Type<select class="input" name="kind"><option value="preference" ${value.kind === 'preference' ? 'selected' : ''}>Preference · how to work</option><option value="observation" ${value.kind === 'observation' ? 'selected' : ''}>Observation · evidence to recheck</option></select></label></div><label class="field-label" for="memory-content">Memory</label><textarea class="input" id="memory-content" name="content" rows="4" maxlength="2000" required>${e(value.content || '')}</textarea><label class="field-label" for="memory-evidence">Source or evidence <small>Optional</small></label><textarea class="input" id="memory-evidence" name="evidence" rows="2" maxlength="2000">${e(value.evidence || '')}</textarea><div class="memory-form-grid"><label>Expires at (UTC)<input class="input" id="memory-expiry" name="expiresAt" type="datetime-local" value="${e(value.expiresAt?.slice(0, 16) || '')}"><small>Useful for environment observations.</small></label><label>Status<select class="input" name="status">${[
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
    )}</select></label></div><div class="modal-footer"><button class="btn secondary" type="button" data-action="close-modal">Cancel</button><button class="btn primary" type="submit">Save memory</button></div></form>`;
}
export function runMemories(task) {
  const runs = task.attempts.filter((a) => a.memorySnapshot),
    latest = runs.at(-1);
  const entries = latest?.memorySnapshot.entries ?? [];
  return `<section class="context-card task-memory-card"><div class="context-title">MEMORY <span>${entries.length} in latest run</span></div>${
    entries.length
      ? `<ul class="memory-compact-list">${entries
          .slice(0, 3)
          .map((m) => `<li>${e(m.title)}<small>${e(m.scope)}</small></li>`)
          .join(
            '',
          )}</ul>${entries.length > 3 ? `<small>${entries.length - 3} more included</small>` : ''}`
      : '<p>No memories included in the latest run.</p>'
  }<div class="memory-compact-actions"><button class="btn text small" data-action="task-memory">Add memory</button><button class="btn text small" data-action="memory-history">View run history (${runs.length})</button></div></section>`;
}
export function memoryRunHistory(task, selectedId) {
  const runs = task.attempts
    .filter((a) => a.memorySnapshot)
    .slice()
    .reverse();
  const selected = runs.find((a) => a.id === selectedId) ?? runs[0];
  return `<div class="memory-history"><nav aria-label="Memory run history">${runs.map((a, i) => `<button class="memory-history-run ${a.id === selected?.id ? 'selected' : ''}" data-action="memory-select-run" data-id="${e(a.id)}"><strong>${e(a.role === 'debug' ? 'Debugger' : a.stage)} · ${e(a.harness)}</strong><small>${i === 0 ? 'Latest · ' : ''}${e(new Date(a.startedAt).toLocaleString())} · ${a.memorySnapshot.entries.length} memories</small></button>`).join('') || '<p>No run snapshots yet.</p>'}</nav><section aria-label="Selected run memory">${selected ? `<h3>Context received by this run</h3>${selected.memorySnapshot.entries.map((m) => `<article class="memory-run-entry"><strong>${e(m.title)}</strong><small>v${m.revision} · ${e(m.scope)} · ${e(m.kind)}</small><p>${e(m.content)}</p>${m.evidence ? `<small>${e(m.evidence)}</small>` : ''}</article>`).join('') || '<p>No active memories were included.</p>'}${selected.memorySnapshot.omitted ? `<p>${selected.memorySnapshot.omitted} memories omitted to keep context bounded.</p>` : ''}` : ''}</section></div>`;
}

export function answerMemories(snapshot) {
  if (!snapshot) return '';
  return `<details class="report-section"><summary>Memory used by this answer <span>${snapshot.entries.length}</span></summary>${snapshot.entries.map((m) => `<div class="memory-run-entry"><strong>${e(m.title)} <small>v${m.revision} · ${e(m.scope)}</small></strong><p>${e(m.content)}</p></div>`).join('') || '<p>No active memories were included.</p>'}${snapshot.omitted ? `<p>${snapshot.omitted} memories omitted to keep context bounded.</p>` : ''}</details>`;
}
