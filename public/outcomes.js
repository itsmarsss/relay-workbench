import { e, duration, stageNames, harnessBadge, icon } from './ui.js';
const stages = ['triage', 'investigate', 'plan', 'implement', 'review'];
const agentName = (id) => ({ codex: 'Codex', claude: 'Claude', pi: 'Pi' })[id] ?? id;
const modelName = (model) => (model === null ? 'Model not recorded' : model || 'Provider default');
function evidenceStatus(row, config, report) {
  if (row.model === null) return 'Model not recorded';
  if (!config.harnesses[row.harness]?.enabled) return 'Agent disabled';
  if (row.model !== (config.harnesses[row.harness]?.model ?? ''))
    return 'Different model configured';
  if (row.eligible) return 'Enough evidence';
  const remaining = [];
  if (row.settled < report.minimumSamples)
    remaining.push(`${report.minimumSamples - row.settled} more settled`);
  if (row.tasks < report.minimumTasks)
    remaining.push(
      `${report.minimumTasks - row.tasks} more ${report.minimumTasks - row.tasks === 1 ? 'task' : 'tasks'}`,
    );
  return remaining.length ? `Needs ${remaining.join(' · ')}` : 'More evidence needed';
}
function evidenceRow(row, config, report) {
  const current =
    config.routing[row.stage] === row.harness &&
    row.model === (config.harnesses[row.harness]?.model ?? '');
  const percentage = row.settled ? `${Math.round((row.successful / row.settled) * 100)}%` : '—';
  return `<article class="evidence-row"><div class="evidence-agent">${harnessBadge(row.harness)}<div><strong>${e(agentName(row.harness))}${current ? '<span class="evidence-tag">Current</span>' : ''}</strong><span class="evidence-model">${e(modelName(row.model))}</span></div></div><div class="evidence-metric" role="group" aria-label="Pass rate"><span class="evidence-mobile-label">Pass rate</span><strong>${percentage}</strong><span>${row.successful} of ${row.settled} settled</span></div><div class="evidence-metric" role="group" aria-label="Typical time"><span class="evidence-mobile-label">Typical time</span><strong>${row.medianMs === null ? '—' : e(duration(row.medianMs))}</strong><span>${row.tasks} ${row.tasks === 1 ? 'task' : 'tasks'}</span></div><div class="evidence-confidence"><span class="evidence-status ${row.eligible ? 'is-ready' : ''}">${e(evidenceStatus(row, config, report))}</span><details class="evidence-details" data-event-key="evidence-${e(JSON.stringify([row.stage, row.harness, row.model]))}"><summary>Details</summary><dl><div><dt>Failed</dt><dd>${row.failed}</dd></div><div><dt>Pending</dt><dd>${row.pending}</dd></div><div><dt>Interrupted</dt><dd>${row.interrupted}</dd></div><div><dt>90th percentile time</dt><dd>${row.p90Ms === null ? '—' : e(duration(row.p90Ms))}</dd></div><div><dt>Review findings</dt><dd>${row.reviewFindings}</dd></div><div><dt>Accepted tasks</dt><dd>${row.acceptedTasks}</dd></div><div><dt>Conservative pass estimate</dt><dd>${row.settled ? `${Math.round(row.confidenceLower * 100)}%` : '—'}</dd></div></dl></details></div></article>`;
}
export function outcomesView(report, config, repositoryId) {
  if (!report)
    return '<section class="settings-panel routing-evidence"><h2>Routing evidence</h2><p class="evidence-muted" role="status">Loading results…</p></section>';
  const recommendations = report.recommendations;
  const changes = recommendations.filter((r) => config.routing[r.stage] !== r.harness);
  const scope = config.repositories.find((r) => r.id === repositoryId)?.name;
  return `<section class="settings-panel routing-evidence" aria-label="Routing evidence"><header class="evidence-heading"><div><h2>Routing evidence</h2><p>Choose stage defaults using results from your live runs.</p></div><div class="evidence-scope"><label for="outcomes-repository">Results from</label><select class="input" id="outcomes-repository"><option value="">All repositories</option>${config.repositories.map((r) => `<option value="${e(r.id)}" ${r.id === repositoryId ? 'selected' : ''}>${e(r.name)}</option>`).join('')}</select></div></header><section class="evidence-advice"><div class="evidence-advice-heading">${icon(changes.length ? 'spark' : recommendations.length ? 'check' : 'clock')}<div><h3>Suggested defaults</h3><p>${changes.length ? `${changes.length} ${changes.length === 1 ? 'stage could use a different agent' : 'stages could use different agents'}. Review the results below.` : recommendations.length ? 'Your current routes match the available evidence.' : report.rows.length ? 'Keep your current routes while more results come in.' : 'Run a live task to start comparing agents.'}</p></div></div>${recommendations.length ? `<ul class="evidence-recommendations">${recommendations.map((r) => `<li><strong>${e(stageNames[r.stage] ?? r.stage)}</strong><span class="evidence-route">${config.routing[r.stage] !== r.harness ? `<span>${e(agentName(config.routing[r.stage]))}</span>${icon('arrow')}<b>${e(agentName(r.harness))}</b>` : `<b>${e(agentName(r.harness))}</b><span class="evidence-tag">Keep current</span>`}</span><small>${r.samples} settled · ${r.alternatives} ${r.alternatives === 1 ? 'eligible agent' : 'eligible agents'}</small></li>`).join('')}</ul>` : `<p class="evidence-threshold">Needs ${report.minimumSamples} settled attempts across ${report.minimumTasks} tasks per stage, agent and configured model. Demo runs are excluded.</p>`}${changes.length ? `<div class="evidence-apply"><button class="btn secondary" data-action="apply-routing-advice">Apply ${changes.length === 1 ? 'suggested route' : `${changes.length} suggested routes`}</button><span>Updates global defaults for new tasks${scope ? `, using ${e(scope)} results` : ''}. Existing tasks and model settings stay unchanged.</span></div>` : ''}</section>${
    report.rows.length
      ? `<div class="evidence-stages">${stages
          .filter((stage) => report.rows.some((row) => row.stage === stage))
          .map(
            (stage) =>
              `<section class="evidence-stage" aria-label="${e(stageNames[stage])} results"><header><h3>${e(stageNames[stage])}</h3><span>Default: ${e(agentName(config.routing[stage]))}</span></header><div class="evidence-columns" aria-hidden="true"><span>Agent / model</span><span>Pass rate</span><span>Typical time</span><span>Recommendation readiness</span></div>${report.rows
                .filter((row) => row.stage === stage)
                .sort(
                  (a, b) =>
                    Number(b.harness === config.routing[stage]) -
                      Number(a.harness === config.routing[stage]) ||
                    agentName(a.harness).localeCompare(agentName(b.harness)) ||
                    String(a.model).localeCompare(String(b.model)),
                )
                .map((row) => evidenceRow(row, config, report))
                .join('')}</section>`,
          )
          .join('')}</div>`
      : ''
  }<details class="evidence-method" data-event-key="routing-method"><summary>How recommendations work</summary><p>At least ${report.minimumSamples} settled attempts across ${report.minimumTasks} tasks must match an enabled agent’s configured model. Eligible agents are ranked by a conservative pass estimate (the 95% Wilson lower bound), then median time. An eligible agent can be recommended even when no other agent has enough data.</p><p>Typical time is the median recorded run duration, including unsuccessful and interrupted runs with timestamps. Pending and interrupted attempts do not count in the pass rate.</p><p>${e(report.notes)}</p><p>Applying a suggestion updates global stage routing for new tasks, even when results are filtered to one repository. Model settings and existing tasks stay unchanged.</p></details></section>`;
}
