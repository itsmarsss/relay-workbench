import { mentionQuestion } from './task-mentions.js';
import { chatActions } from './chat-actions.js';
import { e, icon, badge, ago } from './ui.js';
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
  const belongs = (proposal) =>
    !proposal.messageId || history.some((message) => message.id === proposal.messageId);
  const pending = (info.proposals ?? []).filter(
    (proposal) => proposal.status === 'pending' && belongs(proposal),
  );
  const taskRequests = (info.taskProposals ?? [])
    .filter((p) => p.status === 'pending' && belongs(p))
    .map(
      (p) =>
        `<section class="workspace-permission"><div><strong>Task changes need approval</strong><p>${e(p.reason)}</p></div><button class="btn secondary small" data-action="review-task-proposal" data-id="${e(p.id)}">Review ${p.changes.length} tasks</button></section>`,
    )
    .join('');
  const requests = pending
    .map(
      (proposal) =>
        `<section class="workspace-permission" data-event-key="permission-${e(proposal.id)}"><div>${icon('settings')}<strong>Settings change needs approval</strong><p>${e(proposal.reason)}</p></div><button class="btn secondary small" data-action="review-workspace-change" data-id="${e(proposal.id)}">Review ${proposal.changes.length} ${proposal.changes.length === 1 ? 'change' : 'changes'}</button></section>`,
    )
    .join('');
  const chats = info.chats ?? [];
  const selectedChat = chats.find((chat) => chat.id === info.chatId);
  const query = (info.chatSearch || '').trim().toLowerCase();
  const chatList = chats.length
    ? `<aside class="relay-chat-list" aria-label="Conversations"><header><strong>Chats <span>${chats.length}</span></strong><button class="icon-button chat-list-close" data-action="toggle-relay-chats" aria-label="Close conversations">${icon('close')}</button></header><button class="btn secondary" data-action="new-relay-chat">${icon('plus')}New chat</button><label class="relay-chat-search">${icon('search')}<input type="search" aria-label="Search conversations" placeholder="Search chats" value="${e(info.chatSearch || '')}"></label><nav aria-label="Choose conversation">${[
        ...chats,
      ]
        .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
        .map(
          (chat) =>
            `<button class="relay-chat-item ${chat.id === info.chatId ? 'is-active' : ''}" data-action="select-relay-chat" data-id="${e(chat.id)}" data-chat-title="${e(chat.title.toLowerCase())}" ${chat.id === info.chatId ? 'aria-current="page"' : ''} ${query && !chat.title.toLowerCase().includes(query) ? 'hidden' : ''}><span class="relay-chat-item-title">${e(chat.title)}${chat.running ? '<i class="chat-working-dot" aria-label="Working"></i>' : ''}</span><small>${chat.running ? 'Working' : chat.messageCount ? `${chat.messageCount} ${chat.messageCount === 1 ? 'message' : 'messages'}` : 'New conversation'}<span> · ${ago(chat.updatedAt || chat.createdAt)}</span></small></button>`,
        )
        .join(
          '',
        )}<p class="relay-chat-no-results" ${chats.some((chat) => chat.title.toLowerCase().includes(query)) ? 'hidden' : ''}>No matching chats</p></nav></aside>`
    : '';
  const mobileBar = chats.length
    ? `<div class="relay-chat-mobile-bar"><button class="btn text small" data-action="toggle-relay-chats" aria-expanded="${!!info.chatListOpen}">${icon('sidebar')}Chats <span>${chats.length}</span></button><button class="icon-button" data-action="new-relay-chat" aria-label="New chat">${icon('plus')}</button></div>`
    : '';
  const chatActionsBar = chats.length
    ? `<div class="relay-conversation-actions"><button class="icon-button" data-action="rename-relay-chat" aria-label="Rename conversation" title="Rename conversation">${icon('edit')}</button><button class="icon-button danger" data-action="delete-relay-chat" aria-label="Delete conversation" title="Delete conversation" ${running || chats.length < 2 ? 'disabled' : ''}>${icon('trash')}</button></div>`
    : '';
  return `<div class="relay-chat-shell ${chats.length ? '' : 'no-chats'} ${compact ? 'is-compact' : ''} ${info.chatListOpen ? 'list-open' : ''}">${mobileBar}<button class="relay-chat-list-backdrop" data-action="toggle-relay-chats" aria-label="Close conversations" tabindex="-1"></button>${chatList}<div class="relay-chat-content"><section class="orchestrator-intro ${compact ? 'compact' : ''}"><div class="orchestrator-heading"><h1 title="${e(selectedChat?.title || 'Relay')}">${e(selectedChat?.title || 'Relay')}</h1><button class="relay-model-button" data-action="workspace-agent-settings" aria-label="Relay model and permissions"><span>${e(info.model || 'Claude')}</span>${icon('chevron')}</button></div><div class="orchestrator-status"><span><i class="${running ? 'is-live' : ''}"></i>${running ? 'Working' : 'Ready'}</span><span>${active.length} active</span><span>${attention.length} need you</span><span>${drafts.length} drafts</span></div>${chatActionsBar}</section><div class="orchestrator-layout ${!compact && attention.length ? 'has-queue' : ''}"><section class="workspace-conversation ${history.length ? 'has-messages' : 'is-empty'}"><div class="workspace-messages" aria-live="polite">${history.length ? history.map((message) => `<article data-event-key="workspace-message-${e(message.id)}"><div class="side-chat-question"><div class="chat-message-heading"><span class="side-chat-speaker">You${message.revisionOf ? ' · Edited' : ''}</span>${chatActions(message, 'workspace', { running })}</div><p>${mentionQuestion(message.question, message.mentions)}</p></div><div class="side-chat-answer"><div class="orchestrator-answer-heading">${icon('relay')}<strong>Relay</strong></div>${answerBody(message)}${chatActions(message, 'workspace', { answer: true })}</div></article>`).join('') : '<div class="orchestrator-welcome"><h2>What are we working on?</h2></div>'}${requests}${taskRequests}</div><form id="workspace-agent-form"><label class="field-label" for="workspace-request">Message Relay</label><textarea class="input" id="workspace-request" data-conversation-id="${e(info.chatId || 'default')}" name="question" title="Enter to send · Shift+Enter for a new line" rows="1" maxlength="10000" required placeholder="Ask Relay · @ to mention a task…"></textarea><div class="workspace-compose-footer">${running ? '<button type="button" class="btn secondary small" data-action="stop-workspace-agent">Stop</button>' : ''}<button class="btn primary small composer-send" type="submit" aria-label="Send" title="Send message" ${running ? 'disabled' : ''}>${icon('arrow')}</button></div></form>${history.length ? '' : `<div class="orchestrator-prompts" aria-label="Suggestions">${prompts.map(([label, prompt]) => `<button type="button" class="orchestrator-prompt" data-action="orchestrator-prompt" data-prompt="${e(prompt)}">${e(label)}</button>`).join('')}</div>`}</section>${
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
  }</div></div></div>`;
}
