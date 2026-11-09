// A diagnostic run at the plan stage is not an implementation proposal.
export function completedPlan(task) {
  return task.attempts?.findLast(
    (attempt) =>
      attempt.stage === 'plan' &&
      attempt.status === 'complete' &&
      attempt.role !== 'debug' &&
      (!task.followUpContext?.id ||
        (attempt.followUpId
          ? attempt.followUpId === task.followUpContext.id
          : Date.parse(attempt.startedAt) >= Date.parse(task.followUpContext.startedAt))) &&
      attempt.handoff?.verdict === 'complete',
  )?.handoff;
}
export function recommendedOption(plan) {
  return plan?.options?.find((option) => option.id === plan.recommendedOptionId) ?? null;
}
