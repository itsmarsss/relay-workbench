import { e } from './ui.js';
export function verificationReport(report) {
  if (!report?.checks?.length) return '';
  return `<details class="report-section"><summary>Checks performed <span>${report.checks.length}</span></summary><ul class="evidence-list">${report.checks.map((check, index) => `<li><strong>${e(check.repositoryId)} · Exit ${e(check.code)}</strong><p>${e(check.summary)}</p>${report.reuse?.some((r) => r.checkIndex === index) ? `<small>Preserved evidence · ${e(report.reuse.find((r) => r.checkIndex === index).reason)}</small>` : ''}<code>${e([check.command, ...check.args].join(' '))}</code><small>Directory: ${e(check.cwd)}</small></li>`).join('')}</ul><h3>Repository requirements</h3><ul>${report.requirements.map((requirement) => `<li>${e(requirement.requirement)}<small>${e(requirement.repositoryId)} · ${e(requirement.source)} · checks ${requirement.checkIndices.map((index) => index + 1).join(', ')}</small></li>`).join('')}</ul></details>`;
}
