import { e, icon, badge } from './ui.js';
import { displayStatus } from './task-status.js';
import { answerBody } from './side-chat.js';
export function workspaceAgentView(history = [], tasks = [], { compact = false, info = {} } = {}) {
  const running = history.some((m) => m.status === 'running');
  const attention = tasks.filter((t) =>
    ['blocked', 'interrupted', 'awaiting_plan', 'awaiting_final'].includes(displayStatus(t)),
  );
  const active = tasks.filter((t) =>
    ['running', 'queued', 'publishing', 'review'].includes(displayStatus(t)),
  );
  const drafts = tasks.filter((t) => displayStatus(t) === 'draft');
  const prompts = [
    ['Prioritize', 'Help me prioritize my tasks.'],
    ['Check progress', 'Show progress on active tasks.'],
    ['Load work', 'Help me choose issues from a board.'],
  ];
  const pending = (info.proposals ?? []).filter((proposal) => proposal.status === 'pending');
  const requests = pending
    .map(
      (proposal) =>
        `<section class="workspace-permission" data-event-key="permission-${e(proposal.id)}"><div>${icon('settings')}<strong>Settings change needs approval</strong><p>${e(proposal.reason)}</p></div><button class="btn secondary small" data-action="review-workspace-change" data-id="${e(proposal.id)}">Review ${proposal.changes.length} ${proposal.changes.length === 1 ? 'change' : 'changes'}</button></section>`,
    )
    .join('');
  return `<section class="orchestrator-intro ${compact ? 'compact' : ''}"><div class="orchestrator-heading">${compact ? '' : '<h1>Relay</h1>'}<button class="relay-model-button" data-action="workspace-agent-settings" aria-label="Relay model and permissions"><span>${e(info.model || 'Claude')}</span>${icon('chevron')}</button></div><div class="orchestrator-status"><span><i class="${running ? 'is-live' : ''}"></i>${running ? 'Working' : 'Ready'}</span><span>${active.length} active</span><span>${attention.length} need you</span><span>${drafts.length} drafts</span></div></section><div class="orchestrator-layout ${!compact && attention.length ? 'has-queue' : ''}"><section class="workspace-conversation ${history.length ? 'has-messages' : 'is-empty'}"><div class="workspace-messages" aria-live="polite">${history.length ? history.map((message) => `<article data-event-key="workspace-message-${e(message.id)}"><div class="side-chat-question"><span class="side-chat-speaker">You</span><p>${e(message.question)}</p></div><div class="side-chat-answer"><div class="orchestrator-answer-heading">${icon('relay')}<strong>Relay</strong></div>${answerBody(message)}</div></article>`).join('') : '<div class="orchestrator-welcome"><h2>What are we working on?</h2></div>'}${requests}</div><form id="workspace-agent-form"><label class="field-label" for="workspace-request">Message Relay</label><textarea class="input" id="workspace-request" name="question" title="Enter to send · Shift+Enter for a new line" rows="2" maxlength="10000" required placeholder="Ask about tasks or paste an issue board URL…"></textarea><div class="workspace-compose-footer"><small>Drafts first. You approve the work.</small>${running ? '<button type="button" class="btn secondary small" data-action="stop-workspace-agent">Stop</button>' : ''}<button class="btn primary small" type="submit" ${running ? 'disabled' : ''}>${running ? 'Working…' : `Send ${icon('arrow')}`}</button></div></form>${history.length ? '' : `<div class="orchestrator-prompts" aria-label="Suggestions">${prompts.map(([label, prompt]) => `<button type="button" class="orchestrator-prompt" data-action="orchestrator-prompt" data-prompt="${e(prompt)}">${e(label)}</button>`).join('')}</div>`}</section>${
    !compact && attention.length
      ? `<aside class="orchestrator-queue"><h2>Needs you <span>${attention.length}</span></h2>${attention
          .slice(0, 5)
          .map(
            (task) =>
              `<button class="orchestrator-task" data-action="open-task" data-id="${e(task.id)}"><strong>${e(task.title)}</strong>${badge(displayStatus(task))}</button>`,
          )
          .join(
            '',
          )}<button class="btn text small" data-action="navigate" data-view="tasks">All tasks ${icon('arrow')}</button></aside>`
      : ''
  }</div>`;
}
