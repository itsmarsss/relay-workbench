import { requireValue } from './domain.js';
import { workspaces } from './task-repositories.js';
export function requirePublicationPrerequisites(task, repositoryId) {
  requireValue(task.preset !== 'investigate', 'Investigation-only tasks cannot publish', 409);
  const entries = workspaces(task);
  const waiting = (task.dependencies ?? [])
    .filter((edge) => edge.repositoryId === repositoryId)
    .map((edge) => entries.find((e) => e.repository.id === edge.dependsOn))
    .filter(
      (entry) =>
        !entry || !['open', 'merged'].includes(entry.publication?.state) || !entry.publication?.url,
    );
  requireValue(
    !waiting.length,
    `Publish prerequisite repositories first: ${waiting.map((e) => e?.repository.name ?? 'Missing repository').join(', ')}`,
    409,
  );
}
