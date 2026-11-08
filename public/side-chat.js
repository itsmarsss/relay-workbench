import { sideAnswerText } from './side-answer.js';
import { answerMemories } from './memory.js';
import { e, prose, icon } from './ui.js';
function sourceActivity(question) {
  const calls = (question.toolCalls ?? []).filter(
    (call) => !/structuredoutput$/i.test(call.name ?? ''),
  );
  if (!calls.length) return '';
  const names = {
    github_read: 'Read GitHub',
    list_tasks: 'Refresh tasks',
    get_task: 'Read task',
    create_draft: 'Create draft',
    read_file: 'Read file',
    list_files: 'List files',
    search: 'Search source',
    git_inspect: 'Inspect Git',
  };
  return `<details class="side-chat-tools" data-event-key="side-tools-${e(question.id)}" ${question.status === 'running' ? 'open' : ''}><summary>Source activity <span>${calls.length}</span></summary><ol>${calls
    .map((call) => {
      const name = call.name?.replace(/^mcp__relay_(?:source|workspace)__/, '') ?? 'inspection';
      const target = [
        call.input?.repository ?? call.input?.repositoryId,
        call.input?.path ??
          call.input?.endpoint ??
          (call.input?.number
            ? `${call.input.operation} #${call.input.number}`
            : call.input?.operation) ??
          call.input?.text ??
          call.input?.title ??
          call.input?.id,
      ]
        .filter(Boolean)
        .join(' · ');
      const status =
        { running: 'Reading…', complete: 'Done', failed: 'Failed', interrupted: 'Stopped' }[
          call.status
        ] ?? call.status;
      return `<li><details data-event-key="side-tool-${e(call.id)}"><summary><span class="side-tool-name">${e(names[name] ?? name)}<small>${e(target || 'Preparing request')}</small></span><span class="side-tool-status ${e(call.status)}">${e(status)}</span></summary><pre>${e(JSON.stringify(call.input ?? {}, null, 2))}</pre>${call.output ? `<pre>${e(call.output)}</pre>` : ''}</details></li>`;
    })
    .join('')}</ol></details>`;
}
export function answerBody(question) {
  return `${sourceActivity(question)}${question.answer ? `<div class="prose side-chat-response">${prose(sideAnswerText(question.answer))}</div>` : ''}${question.error ? `<p class="error-text">${e(question.error)}</p>` : ''}${question.status === 'running' ? `<p class="side-chat-thinking" role="status">${question.toolCalls?.some((call) => call.status === 'running') ? 'Inspecting source…' : question.answer ? 'Replying…' : 'Connecting…'}</p>` : ''}`;
}
export function sideChat(task, open = false) {
  const questions = task.sideQuestions ?? [];
  const running = questions.some((q) => q.status === 'running');
  return `<button class="btn secondary side-chat-launcher" data-action="open-side-chat">Ask Relay <span>↗</span></button>${open ? `<section class="side-chat-drawer" role="region" aria-label="Side conversation"><header data-chat-drag title="Drag to move · double-click to reset"><div><h2>Ask Relay</h2></div><button class="btn text" data-action="close-side-chat" aria-label="Close side conversation">✕</button></header><div class="side-chat-history" tabindex="0" aria-label="Conversation messages">${questions.length ? questions.map((q) => `<article data-event-key="side-question-${e(q.id ?? q.createdAt)}"><div class="side-chat-question"><span class="side-chat-speaker">You</span><p>${e(q.question)}</p></div><div class="side-chat-answer"><div class="side-chat-meta"><strong>Relay</strong><span>${e(q.stage)} · ${e(new Date(q.createdAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }))}</span></div>${answerBody(q)}${answerMemories(q.memorySnapshot)}</div></article>`).join('') : '<div class="side-chat-empty"><span>Make sense of the work</span><p>Ask about findings, tradeoffs, or the next step.</p></div>'}</div><form id="side-question-form"><label class="side-chat-compose-label" for="side-question">Your question</label><textarea class="input" id="side-question" name="question" rows="2" maxlength="10000" required placeholder="Ask about this task…"></textarea><div class="side-chat-compose-footer"><small>Read-only · won’t interrupt the workflow.</small><button class="btn primary small" type="submit" aria-label="Ask without interrupting" ${running ? 'disabled' : ''}>${running ? 'Thinking…' : `Ask ${icon('arrow')}`}</button></div></form><button class="chat-resize" type="button" aria-label="Resize conversation" title="Drag to resize · arrow keys to adjust">${icon('chevron')}</button></section>` : ''}`;
}
