import { e } from './ui.js';

export function automationControl(task) {
  return `<button class="btn ${task.automation?.enabled ? 'secondary' : 'text'} small" data-action="configure-auto">${task.automation?.enabled ? 'Auto on' : 'Auto mode'}${task.automation?.error ? ' · needs attention' : ''}</button>`;
}
export function checkpointControl(task) {
  const count = task.history?.checkpoints?.length ?? 0;
  return `<button class="btn text small workflow-graph-button" data-action="workflow-checkpoints">Checkpoints${count ? ` · ${count}` : ''}</button>${task.fork ? `<a class="back-link" href="#task/${e(task.fork.sourceTaskId)}/overview">Original workflow ↗</a>` : ''}`;
}
export async function workflowControlAction(
  action,
  element,
  { task, api, refresh, showModal, closeModal },
) {
  if (!task) return false;
  if (action === 'configure-auto') {
    showModal(
      'Auto mode',
      `<p class="modal-description">Follow the recommended approach, implement, verify and review. Stops for unresolved choices, missing access or exhausted recovery. Never merges.</p>${task.automation?.error ? `<p class="form-help">${e(task.automation.error)}</p>` : ''}<div class="automation-choices"><button class="btn secondary" data-action="enable-auto" data-scope="reviewed"><strong>Finish reviewed work</strong><small>Accept after passing verification and clean review. Publishing stays manual.</small></button><button class="btn secondary" data-action="enable-auto" data-scope="draft_pr"><strong>Finish through draft PR</strong><small>Also delegate committing and draft PR publication.</small></button></div><p class="form-help">One saved-session continuation is allowed after a runtime limit. Paused tasks stay paused. This delegation applies only to this task.</p><div class="modal-footer">${task.automation?.enabled ? '<button class="btn secondary" data-action="disable-auto">Turn Auto off</button>' : ''}<button class="btn text" data-action="close-modal">Cancel</button></div>`,
    );
    return true;
  }
  if (['enable-auto', 'disable-auto'].includes(action)) {
    await api(`/tasks/${task.id}/automation`, 'POST', {
      enabled: action === 'enable-auto',
      scope: element.dataset.scope ?? task.automation?.scope ?? 'reviewed',
    });
    closeModal();
    await refresh();
    return true;
  }
  if (action === 'workflow-checkpoints') {
    const saved = task.history?.checkpoints ?? [];
    showModal(
      'Workflow checkpoints',
      `<p class="modal-description">Continue from a saved handoff or decision in new worktrees. The original workflow and files stay intact. Ignored files and external state are not restored.</p><div class="checkpoint-list">${saved.length ? saved.map((point) => `<article><div><strong>After ${e(point.role === 'debug' ? 'debugger' : point.stage)}</strong><small>${e(new Date(point.at).toLocaleString())}</small><p>${e(point.summary)}</p></div><button class="btn secondary small" data-action="fork-checkpoint" data-checkpoint="${e(point.id)}">Continue from here</button></article>`).join('') : '<p>No checkpoints yet. They are saved at stage handoffs and debugger decisions.</p>'}</div>`,
    );
    return true;
  }
  if (action === 'fork-checkpoint') {
    const point = task.history?.checkpoints?.find((c) => c.id === element.dataset.checkpoint);
    if (!point) throw new Error('Checkpoint unavailable. Refresh the task.');
    showModal(
      'Continue from checkpoint',
      `<p class="modal-description">Restore the saved files after ${e(point.role === 'debug' ? 'debugger' : point.stage)} into separate worktrees. Earlier investigation stays available; only work after your chosen decision runs again. Current work stays intact. Auto and publication permissions are not inherited.</p><label class="field-label" for="checkpoint-stage">Continue at</label><select class="input" id="checkpoint-stage"><option value="saved">Saved next step</option>${point.approaches?.length ? '<option value="approach">Choose a different implementation approach</option>' : ''}${point.canChooseDebug ? '<option value="decision">Revisit the debugger decision</option>' : ''}${!point.investigationOnly ? '<option value="plan">Write a new plan</option>' : ''}${point.hasApproach && !point.investigationOnly ? '<option value="implement">Continue implementation</option><option value="verify">Verify again</option>' : ''}</select><label class="field-label" for="checkpoint-note">New direction (optional)</label><textarea class="input" id="checkpoint-note" rows="3" maxlength="20000"></textarea><p class="form-help">Saved approach and debugger choices reopen for your selection. Other continuations wait for you to start them. Verification and final acceptance run again. The original workflow keeps its current state.</p><div class="modal-footer"><button class="btn text" data-action="close-modal">Cancel</button><button class="btn primary" data-action="confirm-fork-checkpoint" data-checkpoint="${e(point.id)}">Create continuation</button></div>`,
    );
    return true;
  }
  if (action === 'confirm-fork-checkpoint') {
    element.disabled = true;
    try {
      const result = await api(`/tasks/${task.id}/fork`, 'POST', {
        checkpointId: element.dataset.checkpoint,
        stage: document.getElementById('checkpoint-stage').value,
        note: document.getElementById('checkpoint-note').value,
      });
      closeModal();
      location.hash = `task/${result.id}/overview`;
      await refresh();
    } finally {
      element.disabled = false;
    }
    return true;
  }
  return false;
}
