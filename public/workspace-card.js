import { e, icon } from './ui.js';
export function workspaceCard(task, entry) {
  const dependencies = (task.dependencies ?? [])
    .filter((d) => d.repositoryId === entry.repository.id)
    .map(
      (d) =>
        (task.repositories ?? [task]).find((r) => r.repository.id === d.dependsOn)?.repository
          .name ?? d.dependsOn,
    );
  const mode =
    entry.repository.strategy === 'attach'
      ? 'Existing checkout'
      : entry.repository.strategy === 'managed'
        ? 'Managed worktree'
        : 'Isolated worktree';
  return `<section class="context-card workspace-card"><div class="context-title">WORKSPACE ${icon('git')}</div><div class="workspace-heading"><strong class="workspace-name">${e(entry.repository.name)}</strong><span>${e(mode)}</span></div><div class="workspace-branch"><span>Branch</span><code title="${e(entry.branch || '')}">${e(entry.branch || 'Assigned when started')}</code></div><details class="workspace-details" data-event-key="workspace-${e(entry.repository.id)}"><summary>Workspace details</summary><dl class="detail-facts"><div><dt>Directory</dt><dd><code class="detail-path">${e(entry.workspace || 'Created when started')}</code></dd></div>${dependencies.length ? `<div><dt>Depends on</dt><dd>${e(dependencies.join(', '))}</dd></div>` : ''}</dl></details></section>`;
}
