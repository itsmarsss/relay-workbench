import { e } from './ui.js';
export const bytes = (value) =>
  value < 1024
    ? `${value} B`
    : value < 1024 ** 2
      ? `${(value / 1024).toFixed(1)} KB`
      : value < 1024 ** 3
        ? `${(value / 1024 ** 2).toFixed(1)} MB`
        : `${(value / 1024 ** 3).toFixed(1)} GB`;
export function storageView(report) {
  return `<section class="settings-panel"><div class="panel-heading-row"><h2>Storage and worktrees</h2><button class="btn secondary small" data-action="refresh-storage">Refresh storage</button></div><p>Review disk usage and finished worktrees.</p><details class="settings-disclosure"><summary>Cleanup rules</summary><p>Cleanup only removes clean, finished Relay worktrees with preserved commits. Branches and history remain. Attached checkouts, custom workspace managers, modified files, untracked files and ignored files require manual handling.</p></details>${
    report
      ? `<div class="outcome-grid">${Object.entries(report.storage)
          .map(
            ([name, size]) =>
              `<article class="context-card"><strong>${e(name)}</strong><p>${bytes(size.bytes)} · ${size.files} files${size.truncated ? ' · Partial scan' : ''}</p></article>`,
          )
          .join(
            '',
          )}</div>${report.entries.map((entry, index) => `<article class="context-card"><strong>${e(entry.title)} · ${e(entry.repository)}</strong><p class="wrap mono">${e(entry.path)}</p><p>${e(entry.reason)}${entry.eligible ? ` · ${bytes(entry.bytes)}` : ''}</p>${entry.eligible ? `<button class="btn secondary small" data-action="preview-cleanup" data-entry="${index}">Review cleanup</button>` : ''}</article>`).join('') || '<p>No task worktrees to clean.</p>'}`
      : '<p>Load storage to inspect local usage and cleanup eligibility.</p>'
  }</section><section class="settings-panel"><h2>Backup and restore</h2><p>Save your local Relay data or inspect an archive before restoring it.</p><details class="settings-disclosure"><summary>What’s included and how restore works</summary><p>Archives include task history, approvals, receipts, profiles, images, artifacts, local helper files, workspace patches and untracked files. Full Git checkouts, ignored workspace files, Git object stores, provider-owned native sessions and harness credentials remain external.</p><p>Restore previews the archive and repository commands first, creates a safety backup, and leaves unfinished tasks interrupted. No restored command runs automatically. Archives contain private local data; store them accordingly.</p></details><div class="backup-actions"><button class="btn secondary" data-action="create-backup">Create downloadable backup</button></div>${report?.backups?.length ? `<details><summary>Saved archives (${report.backups.length} most recent)</summary>${report.backups.map((archive) => `<p><a href="${e(archive.downloadUrl)}" download>${e(archive.createdAt)} · ${bytes(archive.bytes)}</a></p>`).join('')}</details>` : ''}<form id="backup-preview-form" class="backup-restore-form"><label class="field-label" for="backup-file">Preview an archive for restore</label><input class="input" id="backup-file" type="file" accept=".gz,application/gzip" required><button class="btn secondary" type="submit">Inspect backup</button></form></section>`;
}
