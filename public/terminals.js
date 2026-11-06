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
// A resumed conversation can span several attempts in the same repository.
export function nativeConversations(task) {
  const conversations = new Map();
  for (const attempt of task.attempts ?? []) {
    if (!attempt.sessionId) continue;
    const repositoryId =
      attempt.workspaceRepositoryId ?? attempt.repositoryId ?? task.repository?.id;
    const key = JSON.stringify([repositoryId, attempt.harness, attempt.sessionId]);
    const count = (conversations.get(key)?.count ?? 0) + 1;
    conversations.delete(key);
    conversations.set(key, { ...attempt, repositoryId, count });
  }
  return [...conversations.values()].reverse().slice(0, 8);
}
function conversationRow(attempt, repos, latest = false) {
  const repo = repos.find((r) => r.repository.id === attempt.repositoryId) ?? repos[0];
  const harness = attempt.harness.charAt(0).toUpperCase() + attempt.harness.slice(1);
  const label = `${harness} · ${stageNames[attempt.stage] ?? attempt.stage}`;
  return `<div class="conversation-row"><div class="conversation-copy"><div class="conversation-title"><strong>${e(label)}</strong>${latest ? '<span class="conversation-latest">Latest</span>' : ''}</div><div class="conversation-meta">${e(repo.repository.name ?? 'Repository')}${attempt.count > 1 ? ` · ${attempt.count} attempts` : ''}</div><code class="conversation-id" title="${e(attempt.sessionId)}">${e(attempt.sessionId)}</code></div><button class="btn secondary small" data-action="resume-session" data-attempt-id="${e(attempt.id)}" data-repository-id="${e(attempt.repositoryId ?? repo.repository.id)}" aria-label="${e(`Take over ${label} conversation in ${repo.repository.name ?? 'repository'}, session ${attempt.sessionId}`)}">Take over</button></div>`;
}
function conversationsView(task, repos) {
  if (['draft', 'completed', 'cancelled', 'manual'].includes(task.status)) return '';
  const [latest, ...earlier] = nativeConversations(task);
  if (!latest) return '';
  return `<section class="native-conversations" aria-label="Agent conversations"><h3>Agent conversations</h3><p>Take over to continue a saved conversation. Automation pauses while you have control.</p>${conversationRow(latest, repos, true)}${earlier.length ? `<details class="earlier-conversations" data-event-key="earlier-conversations"><summary>Earlier conversations (${earlier.length})</summary>${earlier.map((attempt) => conversationRow(attempt, repos)).join('')}</details>` : ''}</section>`;
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
  return `<section class="terminal-panel" aria-label="Live terminals"><div class="context-title">LIVE TERMINALS ${icon('code')}</div>${task.status === 'manual' ? '<h2>You have control</h2><p>Automation is paused. Attach to your shell to edit, then Return to automation when ready.</p>' : ''}<div class="terminal-tabs" role="tablist" aria-label="Terminal sessions">${sessions.length ? sessions.map((s) => `<button role="tab" aria-selected="${s.id === selected?.id}" aria-controls="terminal-output" id="terminal-tab-${e(s.id)}" data-action="terminal-tab" data-terminal-id="${e(s.id)}">${e(s.label)} <span>${s.live ? 'Live' : 'Finished'}</span></button>`).join('') : '<button role="tab" aria-selected="true" aria-controls="terminal-output" id="terminal-tab-empty">Agent terminal</button>'}</div><div id="terminal-output" role="tabpanel" aria-labelledby="terminal-tab-${e(selected?.id ?? 'empty')}"><p class="terminal-status">${e(message)}</p>${selected ? `<div class="terminal-preview-toolbar"><span>${preview?.available ? 'Live preview · updates automatically' : 'Retained output'}</span><button class="btn secondary small" data-action="terminal-follow" aria-pressed="${state.terminalFollow}">Follow latest</button></div><pre id="terminal-preview" class="terminal-preview" tabindex="0" aria-label="Terminal output preview">${e(output || (preview?.available ? 'Waiting for terminal output…' : message))}</pre>` : ''}${selected?.live ? `<div class="terminal-attach"><div class="terminal-attach-heading"><strong>Watch in your terminal</strong><button class="btn secondary small" data-action="copy-terminal" data-command="${e(selected.terminal.attachCommand)}">Copy attach command</button></div><code class="terminal-attach-command">${e(selected.terminal.attachCommand)}</code><p>Attach to watch. Take over before editing. Detach with <kbd>Ctrl+B</kbd>, then <kbd>D</kbd>.</p></div>` : ''}</div>${
    !['completed', 'cancelled', 'manual'].includes(task.status)
      ? `<div class="inline-actions">${repos
          .filter((r) => r.workspace && r.setupCompleted)
          .map(
            (r) =>
              `<button class="btn secondary small" data-action="takeover" data-repository-id="${e(r.repository.id)}">Take over · ${e(r.repository.name)}</button>`,
          )
          .join('')}</div>`
      : ''
  }${conversationsView(task, repos)}</section>`;
}
