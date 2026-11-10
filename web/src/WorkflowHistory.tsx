import { useState } from 'react';
import { Modal } from './Modal';
import { Markdown } from './Markdown';
import { Select } from './UI';
import { Notice, useMutation, useResource } from './Session';
import { asObject, asText } from './task-data';
import type { FullTask } from './TaskExtras';

export type Checkpoint = {
  id: string;
  attemptId: string;
  stage: string;
  nextStage: string;
  role?: string;
  at: string;
  summary: string;
  approaches?: unknown[];
  hasApproach: boolean;
  canChooseDebug: boolean;
};
export type History = {
  checkpoints: Checkpoint[];
  forks: {
    taskId: string;
    title: string;
    status: string;
    checkpointId: string;
    attemptId: string;
    at: string;
  }[];
};
export function AutoControl({ task }: { task: FullTask }) {
  const [open, setOpen] = useState(false),
    [scope, setScope] = useState('reviewed');
  const mutation = useMutation();
  const enabled = asObject(task.automation)?.enabled === true;
  async function save(enabled: boolean) {
    await mutation.run(`/api/tasks/${task.id}/automation`, {
      taskRevision: task.taskRevision,
      enabled,
      scope,
    });
    setOpen(false);
  }
  return (
    <>
      <button
        aria-pressed={enabled}
        onClick={() => (enabled ? void save(false).catch(() => {}) : setOpen(true))}
        disabled={mutation.busy}
      >
        Auto {enabled ? 'on' : 'off'}
      </button>
      {mutation.error && !open && <Notice>{mutation.error}</Notice>}
      {open && (
        <Modal
          title="Authorize Auto mode"
          onClose={() => setOpen(false)}
          onSubmit={(e) => {
            e.preventDefault();
            void save(true).catch(() => {});
          }}
          footer={
            <>
              <button type="button" onClick={() => setOpen(false)}>
                Cancel
              </button>
              <button className="primary" disabled={mutation.busy}>
                Authorize for this task
              </button>
            </>
          }
        >
          <p>
            Relay may approve the recommended approach and accept changes after fresh verification
            and independent review. It stops when a decision cannot be made safely. You can revoke
            this permission at any time.
          </p>
          <Select
            label="Auto stops after"
            value={scope}
            onChange={setScope}
            options={[
              { value: 'reviewed', label: 'Verified and reviewed result' },
              { value: 'draft_pr', label: 'Draft pull request published' },
            ]}
          />
          {mutation.error && <Notice>{mutation.error}</Notice>}
        </Modal>
      )}
    </>
  );
}
export function CheckpointControls({ task, history }: { task: FullTask; history: History | null }) {
  const [open, setOpen] = useState(false),
    [checkpoint, setCheckpoint] = useState(''),
    [stage, setStage] = useState('saved'),
    [note, setNote] = useState('');
  const mutation = useMutation();
  const selected = history?.checkpoints.find((row) => row.id === checkpoint);
  const options = [
    { value: 'saved', label: 'Continue from the saved stage' },
    { value: 'plan', label: 'Revise the approach' },
    ...(selected?.approaches?.length
      ? [{ value: 'approach', label: 'Choose a different saved approach' }]
      : []),
    ...(selected?.hasApproach
      ? [
          { value: 'implement', label: 'Continue implementation' },
          { value: 'verify', label: 'Collect fresh verification' },
        ]
      : []),
    ...(selected?.canChooseDebug
      ? [{ value: 'decision', label: 'Revisit the debugger decision' }]
      : []),
  ];
  async function restore() {
    const result = await mutation.run<FullTask>(`/api/tasks/${task.id}/checkpoint`, {
      taskRevision: task.taskRevision,
      checkpointId: checkpoint,
      stage,
      note,
    });
    setOpen(false);
    location.hash = `task/${result.id}/overview`;
  }
  return (
    <>
      <button
        disabled={!history?.checkpoints.length}
        onClick={() => {
          setCheckpoint(history?.checkpoints.at(-1)?.id || '');
          setOpen(true);
        }}
      >
        Checkpoints{history?.checkpoints.length ? ` · ${history.checkpoints.length}` : ''}
      </button>
      {open && (
        <Modal
          title="Continue from a checkpoint"
          onClose={() => setOpen(false)}
          onSubmit={(e) => {
            e.preventDefault();
            void restore().catch(() => {});
          }}
          footer={
            <>
              <button type="button" onClick={() => setOpen(false)}>
                Cancel
              </button>
              <button className="primary" disabled={mutation.busy || !selected}>
                {mutation.busy ? 'Creating…' : 'Create continuation'}
              </button>
            </>
          }
        >
          <p>
            A new task and worktree preserve your current files. Earlier investigation and choices
            remain available; verification runs again. Dependencies and ignored build files are
            recreated through repository setup.
          </p>
          <Select
            label="Checkpoint"
            value={checkpoint}
            onChange={(value) => {
              setCheckpoint(value);
              setStage('saved');
            }}
            options={(history?.checkpoints || []).map((row) => ({
              value: row.id,
              label: `${row.role === 'debug' ? 'Debugger' : row.stage} · ${new Date(row.at).toLocaleString()}`,
            }))}
          />
          {selected && <Markdown text={selected.summary} />}
          <Select label="Continue with" value={stage} options={options} onChange={setStage} />
          <label className="field">
            Direction (optional)
            <textarea
              rows={2}
              value={note}
              maxLength={20000}
              onChange={(e) => setNote(e.target.value)}
            />
          </label>
          {mutation.error && <Notice>{mutation.error}</Notice>}
        </Modal>
      )}
    </>
  );
}
export function ForkLinks({ task }: { task: FullTask }) {
  const { data } = useResource<History>(`/api/tasks/${task.id}/history`);
  const origin = asObject(task.fork);
  return (
    <>
      {origin && (
        <p className="muted">
          Continued from{' '}
          <a href={`#task/${asText(origin.sourceTaskId)}/overview`}>the original task</a> ·{' '}
          {asText(asObject(task.checkpointRestore)?.status)}
        </p>
      )}
      {!!data?.forks.length && (
        <div className="fork-links" aria-label="Checkpoint continuations">
          {data.forks.map((fork) => (
            <a key={fork.taskId} href={`#task/${fork.taskId}/overview`}>
              <span>↳ {fork.title}</span>
              <small>{fork.status}</small>
            </a>
          ))}
        </div>
      )}
    </>
  );
}
