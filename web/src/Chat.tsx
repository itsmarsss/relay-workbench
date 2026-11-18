import { ReviewChanges } from './ReviewChanges';
import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion } from 'motion/react';
import { useMutation, useResource, useSession, Notice } from './Session';
import { Icon, CopyButton, OptionList, Select, ProviderIcon, RelayMark } from './UI';
import { Markdown } from './Markdown';
import { useImageUpload } from './ImageUpload';
import { Modal } from './Modal';
import { ModelSelect, EffortSelect } from './WorkspacePages';
import { asObject } from './task-data';
import type { Task } from './types';
import { ago } from './presentation';
import { useAnchoredPopover, revealOption } from './useAnchoredPopover';
type Call = { id: string; name: string; status: string; input: unknown };
type Message = {
  id: string;
  question: string;
  answer: string;
  status: string;
  error?: string;
  provider: string;
  model: string;
  effort: string;
  revisionOf?: string;
  mentions: string[];
  toolCalls: Call[];
};
type Proposal = {
  id: string;
  kind: string;
  taskTitle?: string;
  operation?: string;
  reason: string;
  status: string;
  body: Record<string, unknown>;
  before?: Record<string, unknown>;
  error?: string;
};
type Chat = {
  id: string;
  name: string;
  taskId?: string;
  // operator: the working agent with shell, files, git and Relay task actions; otherwise Ask Relay.
  mode?: string;
  revision: number;
  updatedAt?: string;
  messages: Message[];
  proposals?: Proposal[];
};
type ChatMode = 'ask' | 'operator';
// New conversations are Ask Relay. Working in a task's worktree happens in its terminal (Claude);
// conversations created as operator chats earlier keep answering that way.
const newMode: ChatMode = 'ask';
function requestedChat() {
  try {
    return new URLSearchParams(location.hash.split('?')[1]).get('chat') || '';
  } catch {
    return '';
  }
}
function setChatURL(id: string) {
  const [base, query] = location.hash.split('?');
  const params = new URLSearchParams(query);
  if (id) params.set('chat', id);
  else params.delete('chat');
  history.replaceState(null, '', base + (params.size ? '?' + params.toString() : ''));
}
export function ChatPanel({
  taskId = '',
  compact = false,
  persistSelection = true,
}: {
  taskId?: string;
  compact?: boolean;
  persistSelection?: boolean;
}) {
  const { bootstrap } = useSession(),
    list = useResource<Chat[]>(
      '/api/chats' + (taskId ? '?taskId=' + encodeURIComponent(taskId) : ''),
    ),
    tasks = useResource<Task[]>('/api/tasks'),
    mutation = useMutation();
  const [selected, setSelected] = useState(() => (persistSelection ? requestedChat() : '')),
    [draft, setDraft] = useState(''),
    [editing, setEditing] = useState(''),
    [cursor, setCursor] = useState(0),
    [activeMention, setActiveMention] = useState(0),
    [mentionOpen, setMentionOpen] = useState(false),
    [chatQuery, setChatQuery] = useState(''),
    [chatListOpen, setChatListOpen] = useState(false),
    [settings, setSettings] = useState(false),
    [renaming, setRenaming] = useState<Chat | null>(null),
    [rename, setRename] = useState(''),
    [deleting, setDeleting] = useState<Chat | null>(null),
    [provider, setProvider] = useState(''),
    [model, setModel] = useState(''),
    [effort, setEffort] = useState('');
  const chat = useResource<Chat>(selected ? `/api/chats/${selected}` : null),
    scroll = useRef<HTMLDivElement>(null),
    textarea = useRef<HTMLTextAreaElement>(null),
    mentionLayer = useRef<HTMLDivElement>(null),
    follow = useRef(true);
  const workspaceAgent = asObject(bootstrap?.config.workspaceAgent),
    selectedProvider = provider || String(workspaceAgent?.provider || 'claude'),
    configuredModel =
      selectedProvider === String(workspaceAgent?.provider || 'claude')
        ? workspaceAgent?.model
        : undefined,
    displayModel =
      model ||
      String(
        configuredModel ||
          asObject(asObject(bootstrap?.config.harnesses)?.[selectedProvider])?.model ||
          selectedProvider,
      );
  const current = chat.data?.id === selected ? chat.data : null,
    running = current?.messages?.some((m) => m.status === 'running'),
    // The open conversation's mode; before one exists, the mode a new one will get.
    operator = current ? current.mode === 'operator' : newMode === 'operator',
    // The operator runs on Claude, whatever the chat agent setting says.
    sendProvider = operator ? 'claude' : selectedProvider;
  const shownModel =
    operator && selectedProvider !== 'claude'
      ? String(asObject(asObject(bootstrap?.config.harnesses)?.claude)?.model || 'claude')
      : displayModel;
  const uploads = useImageUpload((text) => setDraft((value) => value + text));
  const mentionID = useId();
  const chatNavigationID = useId();
  const chatListToggle = useRef<HTMLButtonElement>(null);
  const chatNavigation = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!chatListOpen) return;
    function outside(event: PointerEvent) {
      const target = event.target as Node;
      if (!chatNavigation.current?.contains(target) && !chatListToggle.current?.contains(target))
        setChatListOpen(false);
    }
    function escape(event: KeyboardEvent) {
      if (event.key !== 'Escape' || document.querySelector('dialog[open]')) return;
      setChatListOpen(false);
      chatListToggle.current?.focus();
    }
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('keydown', escape);
    };
  }, [chatListOpen]);
  const mentionMatch = mentionOpen
      ? draft.slice(0, cursor).match(/(?:^|\s)@([^@\n]{0,60})$/)
      : null,
    mentionQuery = mentionMatch?.[1]?.toLowerCase(),
    suggestions =
      mentionQuery === undefined
        ? []
        : (tasks.data || [])
            .filter(
              (t) =>
                (!taskId || t.id === taskId) &&
                `${t.title} ${t.id}`.toLowerCase().includes(mentionQuery),
            )
            .slice(0, 7);
  useAnchoredPopover(suggestions.length > 0, textarea, mentionLayer, () => setMentionOpen(false), {
    maxHeight: 290,
  });
  useEffect(() => {
    if (!persistSelection) return;
    const followURL = () => setSelected(requestedChat());
    window.addEventListener('popstate', followURL);
    window.addEventListener('hashchange', followURL);
    return () => {
      window.removeEventListener('popstate', followURL);
      window.removeEventListener('hashchange', followURL);
    };
  }, [persistSelection]);
  useEffect(() => {
    if (list.data && !list.data.some((c) => c.id === selected)) {
      const id = list.data[0]?.id || '';
      setSelected(id);
      if (persistSelection) setChatURL(id);
    }
  }, [list.data, selected, persistSelection]);
  useEffect(() => {
    const el = textarea.current;
    if (el) {
      el.style.height = 'auto';
      el.style.height = Math.max(30, Math.min(el.scrollHeight, 160)) + 'px';
    }
  }, [draft]);
  useEffect(() => {
    if (suggestions.length)
      revealOption(
        document.getElementById(mentionID),
        document.getElementById(`${mentionID}-${activeMention}`),
      );
  }, [mentionID, activeMention, suggestions.length]);
  useEffect(() => {
    if (follow.current && scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight;
  }, [current]);
  useEffect(() => {
    setDraft('');
    setEditing('');
    follow.current = true;
  }, [selected]);
  function choose(id: string) {
    setSelected(id);
    if (persistSelection) setChatURL(id);
    setChatListOpen(false);
  }
  async function create(mode: ChatMode = newMode) {
    try {
      const value = await mutation.run<Chat>('/api/chats', {
        taskId,
        name: mode === 'operator' ? 'New operator chat' : 'New conversation',
        mode: mode === 'operator' ? 'operator' : '',
      });
      await list.refresh();
      choose(value.id);
      return value;
    } catch {
      return null;
    }
  }
  async function send() {
    if (uploads.busy) return;
    if (!draft.trim() || running || mutation.busy) return;
    let value = current;
    if (!value) value = await create();
    if (!value) return;
    const mentions = [
      ...new Set([...draft.matchAll(/#task\/([a-f0-9-]{36})\/overview/g)].map((m) => m[1]!)),
    ];
    try {
      await mutation.run(`/api/chats/${value.id}/send`, {
        revision: value.revision,
        question: draft,
        mentions,
        ...(editing ? { revisionOf: editing } : {}),
        provider: sendProvider,
        model: operator && provider && provider !== 'claude' ? '' : model,
        effort: operator && provider && provider !== 'claude' ? '' : effort,
      });
      setDraft('');
      setEditing('');
      follow.current = true;
      await chat.refresh();
      await list.refresh();
    } catch {}
  }
  function mention(task: Task) {
    const before = draft.slice(0, cursor);
    const start = before.lastIndexOf('@');
    const label = task.title.replace(/[\[\]\n]/g, ' ');
    const inserted = `[@${label}](#task/${task.id}/overview) `;
    const next = draft.slice(0, start) + inserted + draft.slice(cursor);
    setDraft(next);
    const position = start + inserted.length;
    setCursor(position);
    setActiveMention(0);
    requestAnimationFrame(() => {
      textarea.current?.focus();
      textarea.current?.setSelectionRange(position, position);
    });
  }
  return (
    <section
      className={`relay-conversations ${compact ? 'compact' : ''} ${chatListOpen ? 'chat-list-open' : ''} ${!current?.messages.length ? 'empty-conversation' : ''}`}
      aria-label={taskId ? 'Ask Relay' : 'Relay conversations'}
    >
      {!compact && (
        <div className="chat-mobile-bar">
          <button
            type="button"
            ref={chatListToggle}
            onClick={() => setChatListOpen(!chatListOpen)}
            aria-expanded={chatListOpen}
            aria-controls={chatNavigationID}
          >
            <Icon name="chat" size={16} />
            Chats
          </button>
          <button
            className="icon-button"
            aria-label="New mobile conversation"
            onClick={() => void create()}
          >
            <Icon name="plus" size={16} />
          </button>
        </div>
      )}
      {!compact && (
        <aside
          className="chat-navigation"
          ref={chatNavigation}
          id={chatNavigationID}
          aria-label="Chats"
        >
          <div className="section-heading">
            <strong>
              Chats <span>{list.data?.length || 0}</span>
            </strong>
          </div>
          <button
            type="button"
            className="new-chat-button"
            disabled={mutation.busy}
            onClick={() => void create()}
          >
            <Icon name="plus" size={16} />
            New chat
          </button>
          <label className="chat-search">
            <Icon name="search" size={16} />
            <input
              aria-label="Search chats"
              placeholder="Search chats"
              value={chatQuery}
              onChange={(event) => setChatQuery(event.target.value)}
            />
          </label>
          <div className="chat-list">
            {list.data
              ?.filter((row) => row.name.toLowerCase().includes(chatQuery.toLowerCase()))
              .map((row) => (
                <div key={row.id} className={row.id === selected ? 'active' : ''}>
                  <button
                    onClick={() => {
                      choose(row.id);
                      setChatListOpen(false);
                    }}
                  >
                    <span>
                      <strong>{row.name}</strong>
                      <small>{ago(row.updatedAt)}</small>
                    </span>
                  </button>
                  <button
                    className="icon-button"
                    aria-label={`Conversation settings: ${row.name}`}
                    title="Conversation settings"
                    onClick={() => {
                      setRenaming(row);
                      setRename(row.name);
                    }}
                  >
                    <Icon name="more" size={15} />
                  </button>
                </div>
              ))}
          </div>
          <button className="text-button" onClick={() => setSettings(true)}>
            <Icon name="settings" size={16} />
            Agent settings
          </button>
        </aside>
      )}
      <div className="chat-conversation">
        <header className="chat-header">
          <div>
            {compact && (list.data?.length || 0) > 1 ? (
              // The dock has no chat list beside it: switch between this task's (or the
              // workspace's) conversations here.
              <div className="chat-switcher">
                <Select
                  label="Conversation"
                  value={selected}
                  options={(list.data || []).map((row) => ({
                    value: row.id,
                    label: row.name,
                    detail: `${row.mode === 'operator' ? 'Operator' : 'Ask'} · ${ago(row.updatedAt)}`,
                  }))}
                  onChange={choose}
                />
              </div>
            ) : compact ? (
              <h2>{current?.name || (taskId ? 'Ask Relay' : 'Relay')}</h2>
            ) : (
              <h1>{current?.name || 'Relay'}</h1>
            )}
          </div>
          <div className="inline">
            {current?.mode === 'operator' && <span className="task-status">Operator</span>}
            {compact && (
              <button
                className="icon-button"
                aria-label={taskId ? 'New side conversation' : 'New conversation'}
                onClick={() => void create()}
              >
                <Icon name="plus" size={16} />
              </button>
            )}
            <button
              className="text-button chat-model-button"
              title={shownModel}
              onClick={() => setSettings(true)}
            >
              <ProviderIcon provider={sendProvider} size={20} />
              <span>{shownModel}</span>
              <Icon name="chevron" size={14} />
            </button>
          </div>
        </header>
        <div
          className="chat-scroll"
          ref={scroll}
          onScroll={() => {
            const el = scroll.current;
            if (el) follow.current = el.scrollHeight - el.scrollTop - el.clientHeight < 90;
          }}
        >
          {(!current || current.messages.length === 0) && (
            <div className="chat-welcome">
              <h2>
                {operator
                  ? taskId
                    ? 'What should I do on this task?'
                    : 'What should I get done?'
                  : taskId
                    ? 'Ask about this task'
                    : 'What are we working on?'}
              </h2>
              {taskId && (
                <p>
                  {operator
                    ? 'The operator works directly in this task’s workspace while Relay holds its stages. It can update the branch, run checks and start work; you still approve plans and accept results.'
                    : 'Inspect the task and its worktree without interrupting the pipeline.'}
                </p>
              )}
              {!taskId && operator && (
                <p>
                  Your agent with its usual tools, plus Relay: it can fix things directly or start,
                  retry and update tasks. It asks before posting to pull requests.
                </p>
              )}
              {(!taskId || operator) && (
                <div className="chat-starters">
                  {(operator
                    ? taskId
                      ? [
                          'Update this branch with main',
                          'Why is this task stuck?',
                          'Fix the failing check',
                        ]
                      : [
                          'What needs my attention?',
                          'Update branches that are behind main',
                          'Retry tasks blocked by flaky checks',
                        ]
                    : [
                        'What needs my attention?',
                        'Check the active workflows',
                        'Help me plan my next task',
                      ]
                  ).map((text) => (
                    <button
                      key={text}
                      onClick={() => {
                        setDraft(text);
                        textarea.current?.focus();
                      }}
                    >
                      {text}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
          {current?.messages.map((message) => (
            <article key={message.id} className="chat-exchange">
              <div className="chat-user-message">
                <div className="message-meta">
                  <strong>You</strong>
                  <span className="message-actions">
                    <CopyButton text={message.question} />
                    <button
                      className="text-button"
                      disabled={running}
                      onClick={() => {
                        setDraft(message.question);
                        setEditing(message.id);
                        textarea.current?.focus();
                      }}
                    >
                      Edit
                    </button>
                  </span>
                </div>
                <Markdown text={message.question} breaks />
                {message.revisionOf && <small className="muted">Revised question</small>}
              </div>
              <div className="chat-assistant-message">
                <div className="message-meta">
                  <span className="inline message-agent">
                    <Icon name="relay" size={16} />
                    <strong>Relay</strong>
                    <small title={message.model || message.provider}>
                      {message.model || message.provider}
                    </small>
                  </span>
                  <CopyButton text={message.answer} />
                </div>
                {message.toolCalls.length > 0 && (
                  <details className="chat-tool-calls">
                    <summary>
                      {message.toolCalls.filter((c) => c.status === 'complete').length}/
                      {message.toolCalls.length} tools completed
                    </summary>
                    {message.toolCalls.map((call) => (
                      <details key={call.id}>
                        <summary>
                          <span className={`tool-dot ${call.status}`} />
                          {call.name.replace(/^mcp__relay__/, '').replaceAll('_', ' ')}
                          <small>{call.status}</small>
                        </summary>
                        <pre>{JSON.stringify(call.input, null, 2)}</pre>
                      </details>
                    ))}
                  </details>
                )}
                {message.answer ? (
                  <Markdown text={message.answer} />
                ) : message.status === 'running' ? (
                  <div className="agent-working" role="status">
                    <span />
                    Working…
                  </div>
                ) : null}
                {message.error && <Notice>{message.error}</Notice>}
                {message.status === 'interrupted' && (
                  <p className="muted">Response stopped. Your question is saved.</p>
                )}
              </div>
            </article>
          ))}
          {current?.proposals?.map((p) => (
            <article className="chat-proposal surface" key={p.id}>
              <div className="section-heading">
                <h3>
                  {p.kind === 'configuration'
                    ? 'Settings change'
                    : p.kind === 'storage'
                      ? 'Storage policy'
                      : p.taskTitle || 'Task change'}
                </h3>
                <span className="task-status">{p.status}</span>
              </div>
              <Markdown text={p.reason} />
              <details>
                <summary>Review exact changes{p.operation ? ' · ' + p.operation : ''}</summary>
                <ReviewChanges before={p.before} after={p.body} />
              </details>
              {p.error && <Notice>{p.error}</Notice>}
              {p.status === 'pending' && (
                <div className="record-actions">
                  <button
                    disabled={mutation.busy}
                    onClick={() =>
                      void mutation
                        .run(`/api/chats/${selected}/proposal`, {
                          proposalId: p.id,
                          decision: 'reject',
                        })
                        .then(chat.refresh)
                        .catch(() => {})
                    }
                  >
                    Decline
                  </button>
                  <button
                    className="primary"
                    disabled={mutation.busy}
                    onClick={() =>
                      void mutation
                        .run(`/api/chats/${selected}/proposal`, {
                          proposalId: p.id,
                          decision: 'approve',
                        })
                        .then(chat.refresh)
                        .catch(() => {})
                    }
                  >
                    Approve change
                  </button>
                </div>
              )}
            </article>
          ))}
        </div>
        <form
          className="chat-composer"
          onSubmit={(e) => {
            e.preventDefault();
            void send();
          }}
        >
          {(list.error || chat.error || mutation.error) && (
            <Notice>{list.error || chat.error || mutation.error}</Notice>
          )}
          {editing && (
            <div className="composer-editing">
              <span>Editing a saved question</span>
              <button
                type="button"
                className="text-button"
                onClick={() => {
                  setEditing('');
                  setDraft('');
                }}
              >
                Cancel edit
              </button>
            </div>
          )}
          <div className="composer-input">
            {suggestions.length > 0 &&
              typeof document !== 'undefined' &&
              createPortal(
                <div
                  ref={mentionLayer}
                  className="select-popover mention-suggestions"
                  role="region"
                  aria-label="Task mentions"
                  style={{
                    position: 'fixed',
                    inset: 'auto',
                    visibility: 'hidden',
                    margin: 0,
                    zIndex: 1100,
                  }}
                >
                  <OptionList
                    id={mentionID}
                    label="Mention a task"
                    items={suggestions.map((task) => ({
                      value: task.id,
                      label: task.title,
                      detail: `${task.repository?.name} · ${task.id.slice(0, 8)}`,
                    }))}
                    active={activeMention}
                    onActive={setActiveMention}
                    onChoose={(id) => {
                      const task = suggestions.find((item) => item.id === id);
                      if (task) mention(task);
                    }}
                    empty="No matching tasks"
                  />
                </div>,
                textarea.current?.closest('dialog') || document.body,
              )}
            <textarea
              rows={1}
              onPaste={uploads.onPaste}
              onDrop={uploads.onDrop}
              onDragOver={uploads.onDragOver}
              ref={textarea}
              aria-label={taskId ? 'Ask Relay about this task' : 'Message Relay'}
              aria-autocomplete="list"
              aria-controls={suggestions.length ? mentionID : undefined}
              aria-activedescendant={
                suggestions[activeMention] ? `${mentionID}-${activeMention}` : undefined
              }
              placeholder={
                operator
                  ? taskId
                    ? 'Tell the operator what to do on this task…'
                    : 'Tell the operator what to do · @ to mention a task'
                  : taskId
                    ? 'Ask about this task…'
                    : 'Message Relay · @ to mention a task'
              }
              value={draft}
              onChange={(e) => {
                setMentionOpen(true);
                setDraft(e.target.value);
                setCursor(e.target.selectionStart);
                setActiveMention(0);
              }}
              onSelect={(e) => setCursor(e.currentTarget.selectionStart)}
              onFocus={() => setMentionOpen(true)}
              onBlur={() => setMentionOpen(false)}
              onKeyDown={(e) => {
                if (e.nativeEvent.isComposing) return;
                if (e.key === 'Escape' && suggestions.length) {
                  e.preventDefault();
                  e.stopPropagation();
                  setMentionOpen(false);
                  return;
                }
                if (suggestions.length && ['ArrowDown', 'ArrowUp'].includes(e.key)) {
                  e.preventDefault();
                  setActiveMention(
                    Math.max(
                      0,
                      Math.min(
                        suggestions.length - 1,
                        activeMention + (e.key === 'ArrowDown' ? 1 : -1),
                      ),
                    ),
                  );
                  return;
                }
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  if (suggestions[activeMention]) mention(suggestions[activeMention]!);
                  else void send();
                }
              }}
            />
            {running ? (
              <button
                type="button"
                className="stop-response"
                disabled={mutation.busy}
                onClick={() =>
                  void mutation
                    .run(`/api/chats/${selected}/stop`, {})
                    .then(chat.refresh)
                    .catch(() => {})
                }
              >
                Stop
              </button>
            ) : (
              <button
                className="primary send-message"
                aria-label="Send message"
                disabled={!draft.trim() || mutation.busy || uploads.busy || !bootstrap}
              >
                <Icon name="send" size={18} />
              </button>
            )}
          </div>
          <div className="composer-meta">
            {uploads.control}
            <small className="composer-hint">
              {operator
                ? 'Operator · Runs on Claude with your tools · Enter to send'
                : taskId
                  ? 'Read only · Your pipeline keeps running'
                  : 'Enter to send · Shift+Enter for a new line'}
            </small>
          </div>
        </form>
      </div>
      {settings && (
        <Modal
          title="Relay agent"
          onClose={() => setSettings(false)}
          onSubmit={(e) => {
            e.preventDefault();
            setSettings(false);
          }}
          footer={<button className="primary">Done</button>}
        >
          <p className="muted">Model and effort apply to the next message in this view.</p>
          <label className="field">
            Agent
            <Select
              label="Chat agent"
              value={selectedProvider}
              options={['codex', 'claude', 'pi'].map((value) => ({
                value,
                label: value === 'codex' ? 'Codex' : value === 'claude' ? 'Claude' : 'Pi',
                icon: <ProviderIcon provider={value} size={22} />,
                disabled:
                  asObject(asObject(bootstrap?.config.harnesses)?.[value])?.enabled !== true,
              }))}
              onChange={(value) => {
                setProvider(value);
                setModel('');
                setEffort('');
              }}
            />
          </label>
          <label className="field">
            Model
            <ModelSelect provider={selectedProvider} value={model} onChange={setModel} />
          </label>
          <label className="field">
            Effort
            <EffortSelect provider={selectedProvider} value={effort} onChange={setEffort} />
          </label>
        </Modal>
      )}
      {renaming && (
        <Modal
          title="Conversation settings"
          onClose={() => setRenaming(null)}
          onSubmit={(e) => {
            e.preventDefault();
            void mutation
              .run(
                `/api/chats/${renaming.id}`,
                { revision: renaming.revision, name: rename },
                'PATCH',
              )
              .then(() => {
                setRenaming(null);
                return list.refresh();
              })
              .catch(() => {});
          }}
          footer={
            <>
              <button
                className="danger text-button"
                type="button"
                onClick={() => {
                  setDeleting(renaming);
                  setRenaming(null);
                }}
              >
                Delete conversation
              </button>
              <button type="button" onClick={() => setRenaming(null)}>
                Cancel
              </button>
              <button className="primary" disabled={mutation.busy}>
                Save name
              </button>
            </>
          }
        >
          <label className="field">
            Name
            <input
              autoFocus
              required
              maxLength={100}
              value={rename}
              onChange={(e) => setRename(e.target.value)}
            />
          </label>
          {mutation.error && <Notice>{mutation.error}</Notice>}
        </Modal>
      )}
      {deleting && (
        <Modal
          title="Delete conversation?"
          onClose={() => setDeleting(null)}
          onSubmit={(e) => {
            e.preventDefault();
            void mutation
              .run(`/api/chats/${deleting.id}`, { revision: deleting.revision }, 'DELETE')
              .then(() => {
                setDeleting(null);
                return list.refresh();
              })
              .catch(() => {});
          }}
          footer={
            <>
              <button type="button" onClick={() => setDeleting(null)}>
                Cancel
              </button>
              <button className="danger" disabled={mutation.busy}>
                Delete conversation
              </button>
            </>
          }
        >
          <p>Delete “{deleting.name}” and its messages?</p>
          {mutation.error && <Notice>{mutation.error}</Notice>}
        </Modal>
      )}
    </section>
  );
}
export function RelayPage() {
  return <ChatPanel />;
}
const askWidthKey = 'relay-ask-width';
// Docked beside the page the conversation leaves the task at least 920px; on narrower windows it
// lies over the page instead and may use the full width.
function fitAskWidth(width: number) {
  const docked = window.innerWidth >= 1280,
    most = docked ? Math.min(640, window.innerWidth - 920) : Math.min(640, window.innerWidth);
  return Math.round(Math.min(most, Math.max(Math.min(360, most), width)));
}
export function SideChat({ taskId }: { taskId: string }) {
  const [open, setOpen] = useState(() => {
      try {
        return new URLSearchParams(location.hash.split('?')[1]).get('ask') === '1';
      } catch {
        return false;
      }
    }),
    [width, setWidth] = useState(() => {
      let stored = 0;
      try {
        stored = Number(localStorage.getItem(askWidthKey));
      } catch {}
      return fitAskWidth(stored || 420);
    }),
    [viewport, setViewport] = useState(() => window.innerWidth),
    [slot, setSlot] = useState<HTMLElement | null>(null);
  const launcher = useRef<HTMLButtonElement>(null),
    drag = useRef<{ x: number; width: number } | null>(null);
  useEffect(() => {
    setSlot(document.getElementById('ask-dock'));
    const followURL = () =>
      setOpen(new URLSearchParams(location.hash.split('?')[1]).get('ask') === '1');
    const resize = () => {
      setViewport(window.innerWidth);
      setWidth((current) => fitAskWidth(current));
    };
    window.addEventListener('hashchange', followURL);
    window.addEventListener('popstate', followURL);
    window.addEventListener('resize', resize);
    return () => {
      window.removeEventListener('hashchange', followURL);
      window.removeEventListener('popstate', followURL);
      window.removeEventListener('resize', resize);
    };
  }, []);
  function toggle() {
    const next = !open;
    setOpen(next);
    const [base, q] = location.hash.split('?'),
      params = new URLSearchParams(q);
    if (next) params.set('ask', '1');
    else params.delete('ask');
    history.replaceState(null, '', base + (params.size ? '?' + params.toString() : ''));
    if (!next) launcher.current?.focus({ preventScroll: true });
    else
      requestAnimationFrame(() =>
        document
          .querySelector<HTMLElement>(`#side-chat-${CSS.escape(taskId)} textarea`)
          ?.focus({ preventScroll: true }),
      );
  }
  function resizeTo(value: number) {
    const next = fitAskWidth(value);
    setWidth(next);
    try {
      localStorage.setItem(askWidthKey, String(next));
    } catch {}
  }
  const least = fitAskWidth(0),
    most = fitAskWidth(Infinity);
  return (
    <>
      <button
        ref={launcher}
        className="ask-relay-launcher"
        onClick={toggle}
        aria-expanded={open}
        aria-controls={open ? `side-chat-${taskId}` : undefined}
      >
        <Icon name="relay" size={15} />
        Ask Relay
      </button>
      {slot &&
        createPortal(
          <AnimatePresence>
            {open && (
              <motion.aside
                id={`side-chat-${taskId}`}
                aria-label="Task conversation"
                className="ask-dock"
                // The task page gives up its second column while a docked conversation leaves it
                // too little room for both; below 1280px it floats over the page instead.
                data-squeeze={viewport >= 1280 && viewport - width < 1200}
                // It slides in from the right edge on a negative margin, so the page gives up the
                // room as it arrives; the width itself is plain style and follows a resize at once.
                style={{ width }}
                initial={{ marginRight: -width }}
                animate={{ marginRight: 0 }}
                exit={{ marginRight: -width, transition: { duration: 0.18, ease: 'easeIn' } }}
                transition={{ duration: 0.24, ease: [0.2, 0.8, 0.2, 1] }}
                onKeyDown={(event) => {
                  if (event.key === 'Escape' && !(event.target as HTMLElement).closest('dialog')) {
                    event.preventDefault();
                    toggle();
                  }
                }}
              >
                <div className="ask-dock-panel">
                  <div
                    className="ask-dock-resize"
                    role="separator"
                    tabIndex={0}
                    aria-label="Resize Ask Relay"
                    aria-orientation="vertical"
                    aria-valuemin={least}
                    aria-valuemax={most}
                    aria-valuenow={width}
                    onDoubleClick={() => resizeTo(420)}
                    onKeyDown={(event) => {
                      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
                      event.preventDefault();
                      resizeTo(
                        event.key === 'Home'
                          ? least
                          : event.key === 'End'
                            ? most
                            : width + (event.key === 'ArrowLeft' ? 24 : -24),
                      );
                    }}
                    onPointerDown={(event) => {
                      if (event.button !== 0) return;
                      event.preventDefault();
                      drag.current = { x: event.clientX, width };
                      event.currentTarget.setPointerCapture(event.pointerId);
                    }}
                    onPointerMove={(event) => {
                      const start = drag.current;
                      if (start) resizeTo(start.width - (event.clientX - start.x));
                    }}
                    onLostPointerCapture={() => {
                      drag.current = null;
                    }}
                    onPointerUp={(event) => {
                      if (event.currentTarget.hasPointerCapture(event.pointerId))
                        event.currentTarget.releasePointerCapture(event.pointerId);
                    }}
                  />
                  <header className="ask-dock-header">
                    <span>
                      <Icon name="relay" size={15} />
                      Ask Relay
                      <small>Read only</small>
                    </span>
                    <button className="icon-button" aria-label="Close Ask Relay" onClick={toggle}>
                      <Icon name="close" size={16} />
                    </button>
                  </header>
                  <ChatPanel key={taskId} taskId={taskId} compact />
                </div>
              </motion.aside>
            )}
          </AnimatePresence>,
          slot,
        )}
    </>
  );
}
