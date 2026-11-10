import { ReviewChanges } from './ReviewChanges';
import { useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { useMutation, useResource, useSession, Notice } from './Session';
import { Icon, CopyButton, Select } from './UI';
import { Markdown } from './Markdown';
import { useImageUpload } from './ImageUpload';
import { Modal } from './Modal';
import { ModelSelect, EffortSelect } from './WorkspacePages';
import { asObject } from './task-data';
import type { Task } from './types';
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
  revision: number;
  messages: Message[];
  proposals?: Proposal[];
};
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
}: {
  taskId?: string;
  compact?: boolean;
}) {
  const { bootstrap } = useSession(),
    list = useResource<Chat[]>(
      '/api/chats' + (taskId ? '?taskId=' + encodeURIComponent(taskId) : ''),
    ),
    tasks = useResource<Task[]>('/api/tasks'),
    mutation = useMutation();
  const [selected, setSelected] = useState(requestedChat),
    [draft, setDraft] = useState(''),
    [editing, setEditing] = useState(''),
    [cursor, setCursor] = useState(0),
    [activeMention, setActiveMention] = useState(0),
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
    running = current?.messages?.some((m) => m.status === 'running');
  const uploads = useImageUpload((text) => setDraft((value) => value + text));
  const mentionMatch = draft.slice(0, cursor).match(/(?:^|\s)@([^@\n]{0,60})$/),
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
  useEffect(() => {
    const followURL = () => setSelected(requestedChat());
    window.addEventListener('popstate', followURL);
    window.addEventListener('hashchange', followURL);
    return () => {
      window.removeEventListener('popstate', followURL);
      window.removeEventListener('hashchange', followURL);
    };
  }, []);
  useEffect(() => {
    if (list.data && !list.data.some((c) => c.id === selected)) {
      const id = list.data[0]?.id || '';
      setSelected(id);
      setChatURL(id);
    }
  }, [list.data, selected]);
  useEffect(() => {
    const el = textarea.current;
    if (el) {
      el.style.height = 'auto';
      el.style.height = Math.max(36, Math.min(el.scrollHeight, 160)) + 'px';
    }
  }, [draft]);
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
    setChatURL(id);
  }
  async function create() {
    try {
      const value = await mutation.run<Chat>('/api/chats', { taskId, name: 'New conversation' });
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
        provider: selectedProvider,
        model,
        effort,
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
      className={`relay-conversations ${compact ? 'compact' : ''}`}
      aria-label={taskId ? 'Ask Relay' : 'Relay conversations'}
    >
      {!compact && (
        <aside className="chat-navigation">
          <div className="section-heading">
            <h1>Relay</h1>
            <button
              className="icon-button"
              aria-label="New conversation"
              disabled={mutation.busy}
              onClick={() => void create()}
            >
              <Icon name="plus" />
            </button>
          </div>
          <div className="chat-list">
            {list.data?.map((row) => (
              <div key={row.id} className={row.id === selected ? 'active' : ''}>
                <button onClick={() => choose(row.id)}>
                  <Icon name="chat" size={16} />
                  <span>{row.name}</span>
                </button>
                <button
                  className="icon-button"
                  aria-label={`Rename ${row.name}`}
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
            <Icon name="relay" size={20} />
            <strong>{current?.name || (taskId ? 'Ask Relay' : 'New conversation')}</strong>
            {taskId && <span className="task-status">Read only</span>}
          </div>
          <div className="inline">
            {compact && (
              <button
                className="icon-button"
                aria-label="New side conversation"
                onClick={() => void create()}
              >
                <Icon name="plus" size={16} />
              </button>
            )}
            <button className="text-button" onClick={() => setSettings(true)}>
              {displayModel}
              <Icon name="settings" size={14} />
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
              <Icon name="relay" size={40} />
              <h2>{taskId ? 'Ask about this task' : 'What are we working on?'}</h2>
              <p>
                {taskId
                  ? 'Inspect the task and its worktree without interrupting the pipeline.'
                  : 'Inspect tasks, read issue context, create drafts, and propose workflow changes.'}
              </p>
              {!taskId && (
                <div className="chat-starters">
                  {[
                    'What needs my attention?',
                    'Check the active workflows',
                    'Help me plan my next task',
                  ].map((text) => (
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
                <Markdown text={message.question} />
                {message.revisionOf && <small className="muted">Revised question</small>}
              </div>
              <div className="chat-assistant-message">
                <div className="message-meta">
                  <span className="inline">
                    <Icon name="relay" size={16} />
                    <strong>Relay</strong>
                    <small>{message.model || message.provider}</small>
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
            {suggestions.length > 0 && (
              <div className="mention-suggestions" role="listbox" aria-label="Mention a task">
                {suggestions.map((task, i) => (
                  <button
                    key={task.id}
                    type="button"
                    role="option"
                    aria-selected={i === activeMention}
                    onPointerDown={(e) => e.preventDefault()}
                    onClick={() => mention(task)}
                  >
                    <span>
                      <strong>{task.title}</strong>
                      <small>
                        {task.repository?.name} · {task.id.slice(0, 8)}
                      </small>
                    </span>
                  </button>
                ))}
              </div>
            )}
            <textarea
              rows={1}
              onPaste={uploads.onPaste}
              onDrop={uploads.onDrop}
              onDragOver={uploads.onDragOver}
              ref={textarea}
              aria-label={taskId ? 'Ask Relay about this task' : 'Message Relay'}
              placeholder={taskId ? 'Ask about this task…' : 'Message Relay · @ to mention a task'}
              value={draft}
              onChange={(e) => {
                setDraft(e.target.value);
                setCursor(e.target.selectionStart);
                setActiveMention(0);
              }}
              onSelect={(e) => setCursor(e.currentTarget.selectionStart)}
              onKeyDown={(e) => {
                if (e.nativeEvent.isComposing) return;
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
          {uploads.control}
          <small className="composer-hint">
            {taskId
              ? 'Read only · Your pipeline keeps running'
              : 'Enter to send · Shift+Enter for a new line'}
          </small>
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
export function SideChat({ taskId }: { taskId: string }) {
  const [open, setOpen] = useState(() => {
      try {
        return new URLSearchParams(location.hash.split('?')[1]).get('ask') === '1';
      } catch {
        return false;
      }
    }),
    [size, setSize] = useState({ width: 540, height: 620 }),
    [position, setPosition] = useState({ x: 0, y: 0 });
  const drag = useRef<{
    x: number;
    y: number;
    startX: number;
    startY: number;
    kind: string;
  } | null>(null);
  function toggle() {
    const next = !open;
    setOpen(next);
    const [base, q] = location.hash.split('?'),
      params = new URLSearchParams(q);
    if (next) params.set('ask', '1');
    else params.delete('ask');
    history.replaceState(null, '', base + (params.size ? '?' + params.toString() : ''));
  }
  function pointer(e: React.PointerEvent, kind: string) {
    if (e.button !== 0) return;
    e.preventDefault();
    drag.current = {
      x: e.clientX,
      y: e.clientY,
      startX: kind === 'resize' ? size.width : position.x,
      startY: kind === 'resize' ? size.height : position.y,
      kind,
    };
    e.currentTarget.setPointerCapture(e.pointerId);
  }
  function move(e: React.PointerEvent) {
    const d = drag.current;
    if (!d) return;
    if (d.kind === 'resize')
      setSize({
        width: Math.min(window.innerWidth - 32, Math.max(360, d.startX - (e.clientX - d.x))),
        height: Math.min(window.innerHeight - 100, Math.max(340, d.startY - (e.clientY - d.y))),
      });
    else
      setPosition({
        x: Math.max(0, Math.min(window.innerWidth - size.width - 24, d.startX - (e.clientX - d.x))),
        y: Math.max(
          0,
          Math.min(window.innerHeight - size.height - 76, d.startY - (e.clientY - d.y)),
        ),
      });
  }
  return (
    <>
      <button className="ask-relay-launcher" onClick={toggle}>
        <Icon name="relay" size={18} />
        Ask Relay
      </button>
      <AnimatePresence>
        {open && (
          <motion.aside
            className="side-chat-window"
            style={{
              width: size.width,
              height: size.height,
              right: 24 + position.x,
              bottom: 76 + position.y,
            }}
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 12 }}
          >
            <div
              className="side-chat-drag"
              onPointerDown={(e) => pointer(e, 'move')}
              onPointerMove={move}
              onPointerUp={() => {
                drag.current = null;
              }}
              onPointerCancel={() => {
                drag.current = null;
              }}
            >
              <span>Task conversation</span>
              <button
                className="icon-button"
                aria-label="Close Ask Relay"
                onPointerDown={(e) => e.stopPropagation()}
                onClick={toggle}
              >
                <Icon name="close" size={16} />
              </button>
            </div>
            <button
              className="side-chat-resize"
              aria-label="Resize Ask Relay"
              onPointerDown={(e) => pointer(e, 'resize')}
              onPointerMove={move}
              onPointerUp={() => {
                drag.current = null;
              }}
              onPointerCancel={() => {
                drag.current = null;
              }}
            >
              <Icon name="resize" size={14} />
            </button>
            <ChatPanel key={taskId} taskId={taskId} compact />
          </motion.aside>
        )}
      </AnimatePresence>
    </>
  );
}
