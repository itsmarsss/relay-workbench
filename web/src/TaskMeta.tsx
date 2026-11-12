import { useState } from 'react';
import { Icon } from './Icons';
import { ago } from './presentation';
import { formatBytes } from './storage';
import type { PullRequest, Task } from './types';
import type { WorkspaceSize } from './useWorkspaceSizes';

export function pullRequestStatus(link: PullRequest): { tone: string; label: string } {
  if (link.state === 'merged') return { tone: 'merged', label: 'Merged' };
  if (link.state === 'closed') return { tone: 'closed', label: 'Closed' };
  if (link.state === 'open')
    return link.draft ? { tone: 'draft', label: 'Draft' } : { tone: 'open', label: 'Open' };
  return { tone: 'unknown', label: 'Status unknown' };
}
const checkLabels: Record<string, string> = {
  passing: 'checks passing',
  failing: 'checks failing',
  pending: 'checks pending',
};
function describe(link: PullRequest) {
  return [
    `Pull request${link.number ? ` #${link.number}` : ''}`,
    pullRequestStatus(link).label.toLowerCase(),
    checkLabels[link.checks],
    link.review === 'approved'
      ? 'approved'
      : link.review === 'changes_requested'
        ? 'changes requested'
        : '',
    link.manual
      ? 'linked by hand'
      : link.checkedAt
        ? `checked ${ago(link.checkedAt).toLowerCase()}`
        : '',
  ]
    .filter(Boolean)
    .join(' · ');
}
// The facts a card carries below its summary: pull request, task id and disk use.
export function TaskMeta({
  task,
  size,
  measuring,
}: {
  task: Task;
  size?: WorkspaceSize;
  measuring: boolean;
}) {
  const [copied, setCopied] = useState(false);
  const links = task.pullRequests || [];
  return (
    <div className="task-card-meta">
      {links.map((link) => {
        const status = pullRequestStatus(link);
        return (
          <a
            key={link.url}
            className={`pr-chip pr-${status.tone}`}
            href={link.url}
            target="_blank"
            rel="noopener noreferrer"
            draggable={false}
            title={describe(link)}
            aria-label={describe(link)}
          >
            <Icon name="pull-request" size={13} />
            {link.number && <span>#{link.number}</span>}
            <span>{status.label}</span>
            {status.tone === 'open' && checkLabels[link.checks] && (
              <i className={`pr-checks pr-checks-${link.checks}`} aria-hidden="true" />
            )}
          </a>
        );
      })}
      {!links.length && (
        <span className="pr-chip pr-none" title="No pull request">
          <Icon name="pull-request" size={13} />
          <span>No PR</span>
        </span>
      )}
      <button
        type="button"
        className="task-id"
        title={copied ? 'Copied' : `Copy task ID ${task.id}`}
        aria-label={`Copy task ID ${task.id}`}
        onClick={() =>
          void navigator.clipboard
            .writeText(task.id)
            .then(() => {
              setCopied(true);
              window.setTimeout(() => setCopied(false), 1500);
            })
            .catch(() => {})
        }
      >
        {copied ? 'Copied' : task.id.slice(0, 8)}
      </button>
      {size ? (
        <span
          className="task-size"
          title={`Workspace on disk, build output included${size.complete ? '' : ' (partly measured)'} · measured ${ago(size.measuredAt).toLowerCase()}`}
        >
          <Icon name="storage" size={13} />
          {size.complete ? '' : '≥ '}
          {formatBytes(size.allocatedBytes)}
        </span>
      ) : (
        measuring && (
          <span className="task-size is-measuring" title="Measuring the workspace on disk">
            <Icon name="storage" size={13} />…
          </span>
        )
      )}
    </div>
  );
}
