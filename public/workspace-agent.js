import { e, icon, badge } from './ui.js';
import { displayStatus } from './task-status.js';
import { answerBody } from './side-chat.js';
export function workspaceAgentView(history = [], tasks = [], { compact = false } = {}) {
  const running = history.some((m) => m.status === 'running');
  const attention = tasks.filter((t) =>
    ['blocked', 'interrupted', 'awaiting_plan', 'awaiting_final'].includes(displayStatus(t)),
  );
  const active = tasks.filter((t) =>
    ['running', 'queued', 'publishing', 'review'].includes(displayStatus(t)),
  );
  const drafts = tasks.filter((t) => displayStatus(t) === 'draft');
  const prompts = [
    [
      'Prioritize',
      'What needs my attention? Summarize blockers and approval decisions across my tasks.',
    ],
    ['Check progress', 'Summarize active work, recent progress, and what happens next.'],
    [
      'Load work',
      'Help me select issues from an issue board and create draft tasks. Ask me for the board URL.',
    ],
  ];
  return `<section class="orchestrator-intro ${compact ? 'compact' : ''}"><div class="orchestrator-heading"><span class="orchestrator-mark">${icon('orchestrator')}</span><div><span class="orchestrator-eyebrow">WORKSPACE ORCHESTRATOR</span><${compact ? 'h2' : 'h1'}>Coordinate your work</${compact ? 'h2' : 'h1'}><p>One place to prioritize tasks, inspect blockers, and prepare what’s next.</p></div></div><div class="orchestrator-status"><span><i class="${running ? 'is-live' : ''}"></i>${running ? 'Relay is working' : 'Ready to help'}</span><span>${active.length} active</span><span>${attention.length} need you</span><span>${drafts.length} drafts</span></div></section><div class="orchestrator-layout"><section class="workspace-conversation"><div class="workspace-messages" aria-live="polite">${history.length ? history.map((message) => `<article data-event-key="workspace-message-${e(message.id)}"><div class="side-chat-question"><span class="side-chat-speaker">You</span><p>${e(message.question)}</p></div><div class="side-chat-answer"><div class="orchestrator-answer-heading">${icon('orchestrator')}<strong>Relay</strong></div>${answerBody(message)}</div></article>`).join('') : `<div class="orchestrator-welcome"><h3>What should we move forward?</h3><p>Ask about current work, or bring in an issue board.</p><div class="orchestrator-prompts">${prompts.map(([label, prompt]) => `<button type="button" class="orchestrator-prompt" data-action="orchestrator-prompt" data-prompt="${e(prompt)}"><strong>${e(label)}</strong>${icon('arrow')}</button>`).join('')}</div></div>`}</div><form id="workspace-agent-form"><label class="field-label" for="workspace-request">Message Relay</label><textarea class="input" id="workspace-request" name="question" rows="3" maxlength="10000" required placeholder="What should Relay coordinate?"></textarea><div class="workspace-compose-footer"><small>Creates drafts · you approve implementation</small>${running ? '<button type="button" class="btn secondary" data-action="stop-workspace-agent">Stop</button>' : ''}<button class="btn primary" type="submit" ${running ? 'disabled' : ''}>${running ? 'Working…' : `Send ${icon('arrow')}`}</button></div></form></section>${
    !compact
      ? `<aside class="orchestrator-queue"><div class="orchestrator-queue-title"><h2>Needs your attention</h2><span>${attention.length}</span></div>${
          attention.length
            ? attention
                .slice(0, 6)
                .map(
                  (task) =>
                    `<button class="orchestrator-task" data-action="open-task" data-id="${e(task.id)}"><strong>${e(task.title)}</strong>${badge(displayStatus(task))}</button>`,
                )
                .join('')
            : '<p>No pending decisions. Relay can help prepare your next task.</p>'
        }<button class="btn text" data-action="navigate" data-view="tasks">View all tasks ${icon('arrow')}</button></aside>`
      : ''
  }</div>`;
}
