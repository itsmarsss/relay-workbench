import { taskRuns } from './task-runs.js';
import { runLabel } from './run-label.js';
import { e, stageNames } from './ui.js';
import { concise } from './task-summary.js';

export function terminalSessions(task) {
  const sessions = taskRuns(task)
    .map((attempt, index) => ({ attempt, run: index + 1 }))
    .filter(({ attempt }) => attempt.terminal)
    .map(({ attempt, run }) => {
      const repositoryId =
        attempt.workspaceRepositoryId ?? attempt.repositoryId ?? task.repository?.id;
      const repository =
        task.repositories?.find((r) => r.repository.id === repositoryId)?.repository ??
        task.repository;
      const harness = `${attempt.harness.charAt(0).toUpperCase() + attempt.harness.slice(1)}${attempt.role === 'debug' ? ' debugger' : ''}`;
      const live =
        attempt.status === 'running' &&
        (attempt.auxiliary ||
          ['publish', 'monitor'].includes(attempt.stage) ||
          task.status === 'running');
      const status = live
        ? 'Live'
        : attempt.handoff?.verdict === 'blocked'
          ? 'Blocked'
          : ({ failed: 'Failed', interrupted: 'Interrupted' }[attempt.status] ?? 'Finished');
      return {
        id: attempt.id,
        run,
        attempt,
        status,
        label: `${harness} · ${runLabel(attempt)}`,
        repository: repository?.name ?? repositoryId ?? '',
        terminal: attempt.terminal,
        live,
      };
    });
  if (task.manual?.session && task.status === 'manual')
    sessions.push({
      id: 'manual',
      label: 'Your shell',
      status: task.manual.active ? 'Live' : 'Closed',
      terminal: task.manual,
      live: task.manual.active === true,
      attempt: {
        handoff: {
          summary: task.manual.active
            ? ''
            : `Terminal closed${task.manual.result ? ` (${task.manual.result.signal || task.manual.result.code})` : ''}. Reopen it to continue.`,
        },
      },
    });
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
  const harness = `${attempt.harness.charAt(0).toUpperCase() + attempt.harness.slice(1)}${attempt.role === 'debug' ? ' debugger' : ''}`;
  const label = `${harness} · ${stageNames[attempt.stage] ?? attempt.stage}`;
  return `<div class="conversation-row"><div class="conversation-copy"><div class="conversation-title"><strong>${e(label)}</strong>${latest ? '<span class="conversation-latest">Latest</span>' : ''}</div><div class="conversation-meta">${e(repo.repository.name ?? 'Repository')}${attempt.count > 1 ? ` · ${attempt.count} attempts` : ''}</div><code class="conversation-id" title="${e(attempt.sessionId)}">${e(attempt.sessionId)}</code></div><button class="btn secondary small" data-action="resume-session" data-attempt-id="${e(attempt.id)}" data-repository-id="${e(attempt.repositoryId ?? repo.repository.id)}" aria-label="${e(`Take over ${label} conversation in ${repo.repository.name ?? 'repository'}, session ${attempt.sessionId}`)}">Take over</button></div>`;
}
function conversationsView(task, repos) {
  if (['draft', 'completed', 'cancelled', 'manual'].includes(task.status)) return '';
  const [latest, ...earlier] = nativeConversations(task);
  if (!latest) return '';
  return `<section class="native-conversations" aria-label="Agent conversations"><details class="saved-session-details"><summary>Saved agent conversations</summary><p>Take over to continue a saved conversation. Automation pauses while you have control.</p>${conversationRow(latest, repos, true)}${earlier.length ? `<details class="earlier-conversations" data-event-key="earlier-conversations"><summary>Earlier conversations (${earlier.length})</summary>${earlier.map((attempt) => conversationRow(attempt, repos)).join('')}</details>` : ''}</details></section>`;
}
export function retainedActivity(events, attemptId) {
  const seen = new Set();
  return events
    .filter(
      (event) =>
        event.attemptId === attemptId &&
        event.type === 'activity' &&
        ['message', 'tool'].includes(event.kind),
    )
    .map((event) => concise(event.summary || event.details, 240))
    .filter((text) => {
      if (
        !text ||
        /^[{\[]/.test(text) ||
        /^(Starting|Finished) (userMessage|agentMessage|reasoning|turn|thread)$/i.test(text) ||
        seen.has(text)
      )
        return false;
      seen.add(text);
      return true;
    })
    .slice(-6);
}
function runPicker(sessions, selected) {
  if (!selected) return '';
  const latest = sessions.findLast((s) => s.live) ?? sessions.at(-1);
  return `<div class="terminal-run-picker"><label for="terminal-run">Run history <span>${sessions.length} ${sessions.length === 1 ? 'terminal' : 'terminals'}</span></label><div><select class="input" id="terminal-run">${[
    ...sessions,
  ]
    .reverse()
    .map(
      (s) =>
        `<option value="${e(s.id)}" ${s.id === selected.id ? 'selected' : ''}>${e(`${s.run ? `Run ${s.run}` : 'Manual shell'} · ${s.label} · ${s.status}`)}</option>`,
    )
    .join(
      '',
    )}</select>${latest.id !== selected.id ? `<button class="btn secondary small" data-action="terminal-tab" data-terminal-id="${e(latest.id)}">${latest.live ? 'Go to live run' : 'Go to latest run'}</button>` : ''}</div></div>`;
}
function runSummary(selected, events) {
  const summary = selected.attempt?.handoff?.summary || selected.attempt?.error;
  const updates = retainedActivity(
    events.filter((ev) => ev.kind === 'message'),
    selected.id,
  )
    .filter((text) => text !== concise(summary, 240))
    .slice(-3);
  const diagnostics = retainedActivity(
    events.filter((ev) => ev.kind !== 'message'),
    selected.id,
  );
  return `<div class="terminal-run-summary">${summary ? `<p class="terminal-outcome">${e(summary)}</p>` : ''}${updates.length ? `<h3>Agent updates</h3><ul>${updates.map((text) => `<li>${e(text)}</li>`).join('')}</ul>` : !summary ? '<p>No readable updates were recorded for this run. Expand raw output for details.</p>' : ''}${diagnostics.length ? `<details class="report-section" data-event-key="terminal-diagnostics-${e(selected.id)}"><summary>Commands &amp; diagnostics (${diagnostics.length})</summary><ul>${diagnostics.map((text) => `<li>${e(text)}</li>`).join('')}</ul></details>` : ''}</div>`;
}
function interactiveTerminal() {
  return `<div class="browser-terminal-panel"><div class="browser-terminal-toolbar"><span data-browser-terminal-status role="status">Connecting…</span><button class="btn secondary small" data-terminal-key="focus">Focus terminal</button></div><div class="browser-terminal" data-browser-terminal></div><div class="browser-terminal-keys" aria-label="Terminal keys"><button class="btn secondary small" data-terminal-key="interrupt">Ctrl+C</button><button class="btn secondary small" data-terminal-key="escape">Esc</button><button class="btn secondary small" data-terminal-key="tab">Tab</button><button class="btn secondary small" data-terminal-key="up" aria-label="Up arrow">↑</button><button class="btn secondary small" data-terminal-key="down" aria-label="Down arrow">↓</button><button class="btn secondary small" data-terminal-key="enter">Enter</button><span>Type or paste directly into the terminal.</span></div></div>`;
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
        : '';
  const output =
    selected?.id === 'manual'
      ? task.manual.output || ''
      : preview?.available
        ? preview.output
        : history;
  const repos = task.repositories?.length ? task.repositories : [task];
  const started = selected?.attempt?.startedAt;
  const date = started ? new Date(started) : null;
  const timestamp =
    date && !Number.isNaN(date.getTime())
      ? `<time datetime="${e(date.toISOString())}">${e(date.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }))}</time>`
      : '';
  const raw = selected
    ? `<pre id="terminal-preview" class="terminal-preview" tabindex="0" aria-label="Terminal output preview">${e(output || (selected.live ? preview?.message || 'Waiting for terminal output…' : 'No retained output for this run.'))}</pre>`
    : '';
  return `<section class="terminal-panel" aria-label="Live terminals"><div class="panel-heading"><div><h2>Live terminals</h2><p>Watch an agent run, or take over when you need to intervene.</p></div></div>${task.status === 'manual' ? `<h2>You have control</h2><p>${task.manual?.active ? 'Use the terminal below. Return to automation when ready.' : 'The terminal has closed. Reopen it to continue; automation is paused.'}</p>${!task.manual?.active ? `<button class="btn secondary small" data-action="takeover" data-repository-id="${e(task.manual?.repositoryId ?? task.repository.id)}">Reopen terminal</button>` : ''}` : ''}${message ? `<p class="terminal-empty">${e(message)}</p>` : ''}${task.attempts?.at(-1)?.harness === 'checks' && task.status === 'running' ? '<div class="review-callout"><strong>Configured checks are running</strong><p>These checks run without an agent terminal. <button class="btn text small" data-action="tab" data-tab="thread">View check output</button></p></div>' : ''}${runPicker(sessions, selected)}${
    !['completed', 'cancelled', 'manual'].includes(task.status)
      ? `<div class="inline-actions">${repos
          .filter((r) => r.workspace && r.setupCompleted)
          .map(
            (r) =>
              `<button class="btn secondary small" data-action="takeover" data-repository-id="${e(r.repository.id)}">Take over · ${e(r.repository.name)}</button>`,
          )
          .join('')}</div>`
      : ''
  }${selected ? `<section id="terminal-output" aria-label="Selected run"><div class="terminal-run-heading"><div><h2>${e(selected.label)}</h2><p>${selected.run ? `Run ${selected.run} · ` : ''}${e(selected.repository || 'Workspace')}${timestamp ? ` · ${timestamp}` : ''}</p></div><span class="terminal-run-status ${selected.live ? 'is-live' : ''}">${e(selected.status)}</span></div>${selected.id === 'manual' && selected.live ? interactiveTerminal() : selected.live ? `<div class="terminal-preview-toolbar"><span>${preview?.available ? 'Read-only preview · updates automatically' : 'Connecting to terminal…'}</span><button class="btn secondary small" data-action="terminal-follow" aria-pressed="${state.terminalFollow}">Follow latest</button></div>${raw}` : `${runSummary(selected, state.events)}<details class="terminal-raw" data-event-key="terminal-raw-${e(selected.id)}"><summary>Raw output</summary>${raw}<button class="btn text small" data-action="tab" data-tab="transcript" data-run-id="${e(selected.id)}">Open execution log</button></details>`}${selected.live ? `<details class="external-terminal"><summary>Attach from your terminal</summary><div class="terminal-attach"><div class="terminal-attach-heading"><strong>Attach command</strong><button class="btn secondary small" data-action="copy-terminal" data-command="${e(selected.terminal.attachCommand)}">Copy attach command</button></div><code class="terminal-attach-command">${e(selected.terminal.attachCommand)}</code><p>Attach to watch. Take over before editing. Detach with <kbd>Ctrl+B</kbd>, then <kbd>D</kbd>.</p></div></details>` : ''}</section>` : ''}${conversationsView(task, repos)}</section>`;
}
