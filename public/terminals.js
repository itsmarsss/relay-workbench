import { e, icon, stageNames } from './ui.js';

export function terminalSessions(task) {
  const sessions = (task.attempts ?? [])
    .filter((a) => a.terminal)
    .slice(-8)
    .map((a) => ({
      id: a.id,
      label: `${task.repositories?.length > 1 ? (task.repositories.find((r) => r.repository.id === a.repositoryId)?.repository.name ?? a.repositoryId ?? '') + ' · ' : ''}${a.harness} · ${stageNames[a.stage] ?? a.stage}`,
      terminal: a.terminal,
      live: a.status === 'running' && task.status === 'running',
    }));
  if (task.manual?.active && task.status === 'manual')
    sessions.push({ id: 'manual', label: 'Your shell', terminal: task.manual, live: true });
  return sessions;
}
export function terminalSelection(task, selectedId) {
  const sessions = terminalSessions(task);
  return (
    sessions.find((s) => s.id === selectedId) ?? sessions.findLast((s) => s.live) ?? sessions.at(-1)
  );
}
export function terminalView(task, state) {
  const sessions = terminalSessions(task);
  const selected = terminalSelection(task, state.terminalId);
  const preview = state.terminalPreview?.id === selected?.id ? state.terminalPreview : null;
  const history = selected
    ? state.events
        .filter(
          (ev) => ev.attemptId === selected.id && (ev.type === 'activity' || ev.type === 'handoff'),
        )
        .slice(-100)
        .map((ev) => ev.details || ev.summary)
        .join('\n\n')
        .slice(-60000)
    : '';
  const message = task.demo
    ? 'Demo runs are simulated and do not create terminals.'
    : !task.workspace
      ? 'No workspace yet. Start workflow to create a workspace and launch the first agent.'
      : !selected
        ? 'No agent terminal yet. The next agent run will appear here.'
        : selected.live
          ? preview?.available
            ? 'Live terminal · read-only preview.'
            : preview?.message || 'Waiting for terminal output…'
          : 'This terminal has finished. Retained agent output appears below; see the activity thread and transcript for more.';
  const output = preview?.available ? preview.output : history;
  const repos = task.repositories?.length ? task.repositories : [task];
  const nativeSessions = (task.attempts ?? [])
    .filter((a) => a.sessionId && a.repositoryId)
    .slice(-8);
  return `<section class="terminal-panel" aria-label="Live terminals"><div class="context-title">LIVE TERMINALS ${icon('code')}</div>${task.status === 'manual' ? '<h2>You have control</h2><p>Automation is paused. Attach to your shell to edit, then Return to automation when ready.</p>' : ''}<div class="terminal-tabs" role="tablist" aria-label="Terminal sessions">${sessions.length ? sessions.map((s) => `<button role="tab" aria-selected="${s.id === selected?.id}" aria-controls="terminal-output" id="terminal-tab-${e(s.id)}" data-action="terminal-tab" data-terminal-id="${e(s.id)}">${e(s.label)} <span>${s.live ? 'Live' : 'Finished'}</span></button>`).join('') : '<button role="tab" aria-selected="true" aria-controls="terminal-output" id="terminal-tab-empty">Agent terminal</button>'}</div><div id="terminal-output" role="tabpanel" aria-labelledby="terminal-tab-${e(selected?.id ?? 'empty')}"><p class="terminal-status">${e(message)}</p>${selected ? `<div class="terminal-preview-toolbar"><span>${preview?.available ? 'Live preview · updates automatically' : 'Retained output'}</span><button class="btn secondary small" data-action="terminal-follow" aria-pressed="${state.terminalFollow}">Follow latest</button></div><pre id="terminal-preview" class="terminal-preview" tabindex="0" aria-label="Terminal output preview">${e(output || (preview?.available ? 'Waiting for terminal output…' : message))}</pre>` : ''}${selected?.live ? `<div class="terminal-command"><code>${e(selected.terminal.attachCommand)}</code><button class="btn secondary small" data-action="copy-terminal" data-command="${e(selected.terminal.attachCommand)}">Copy attach command</button></div><p>Preview is read-only. Attach in your terminal to watch; use Take over before editing. Ctrl+B, then D detaches.</p>` : ''}</div>${
    !['completed', 'cancelled', 'manual'].includes(task.status)
      ? `<div class="inline-actions">${repos
          .filter((r) => r.workspace && r.setupCompleted)
          .map(
            (r) =>
              `<button class="btn secondary small" data-action="takeover" data-repository-id="${e(r.repository.id)}">Take over · ${e(r.repository.name)}</button>`,
          )
          .join('')}</div>`
      : ''
  }${!['draft', 'completed', 'cancelled', 'manual'].includes(task.status) ? nativeSessions.map((a) => `<div class="context-card"><strong>${e(a.harness)} native conversation</strong><code class="wrap">${e(a.sessionId)}</code><button class="btn secondary small" data-action="resume-session" data-attempt-id="${e(a.id)}" data-repository-id="${e(a.repositoryId)}">Take over this conversation</button></div>`).join('') : ''}</section>`;
}
