import { effortLevels } from './agent-options.js';
import { e } from './ui.js';
import { harnessName, runState } from './run-presentation.js';
export function followUpComposer(task, config = {}, selectedProvider, preferences = {}) {
  if (task.status !== 'completed' || task.demo) return '';
  const latest = (task.deliveryRuns ?? []).findLast((run) => run.stage === 'followup');
  const running = latest?.status === 'running';
  const providers = ['codex', 'claude', 'pi'].filter(
    (id) => config.harnesses?.[id]?.enabled !== false,
  );
  const provider = selectedProvider ?? latest?.harness ?? task.routing?.implement ?? providers[0];
  const settings =
    preferences[provider] ?? (latest?.harness === provider ? latest.settings : null) ?? {};
  const defaultModel = config.harnesses?.[provider]?.model;
  return `<section class="follow-up-panel" aria-label="Continue work"><header><h2>Continue work</h2><p>Give an agent the next request.</p></header><form id="follow-up-form"><label class="sr-only" for="follow-up-message">Follow-up request</label><textarea id="follow-up-message" name="message" class="input" rows="3" maxlength="20000" required placeholder="What would you like the agent to do?"></textarea><div class="follow-up-footer"><label class="follow-up-provider">Agent<select name="provider" class="input" ${running ? 'disabled' : ''}>${providers.map((id) => `<option value="${id}" ${provider === id ? 'selected' : ''}>${e(harnessName(id))}</option>`).join('')}</select></label><label class="follow-up-model">Model<input class="input" id="follow-up-model-${e(provider)}" name="model" value="${e(settings.model ?? '')}" maxlength="200" placeholder="${e(defaultModel ? `Default (${defaultModel})` : 'Provider default')}" ${running ? 'disabled' : ''}></label><label class="follow-up-effort">Effort<select class="input" name="effort" ${running ? 'disabled' : ''}><option value="">Default</option>${(effortLevels[provider] ?? []).map((level) => `<option value="${level}" ${settings.effort === level ? 'selected' : ''}>${e(level === 'xhigh' ? 'Extra high' : level[0].toUpperCase() + level.slice(1))}</option>`).join('')}</select></label><button class="btn primary small" type="submit" ${running ? 'disabled' : ''}>${running ? 'Agent running…' : 'Run agent'}</button></div></form>${latest ? `<div class="follow-up-outcome"><div><span class="run-status ${e(runState(latest).key)}">${e(runState(latest).label)}</span><p>${e(latest.error || latest.handoff?.summary || `${harnessName(latest.harness)} is working on your request.`)}</p></div>${running ? '<button class="btn text small" data-action="follow-up-stop">Stop agent</button>' : ''}<button class="btn text small" data-action="delivery-run" data-id="${e(latest.id)}">View run ↗</button></div>` : ''}</section>`;
}
