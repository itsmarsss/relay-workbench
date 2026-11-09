import type { RelayConfig } from './types.ts';
export function jsonObject(source: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(source || '{}');
  } catch {
    throw new Error('Enter valid JSON.');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('JSON options must be an object.');
  return value as Record<string, unknown>;
}
export function jsonArray(source: string): unknown[] {
  let value: unknown;
  try {
    value = JSON.parse(source || '[]');
  } catch {
    throw new Error('Enter a valid JSON array.');
  }
  if (!Array.isArray(value)) throw new Error('Enter a JSON array.');
  return value;
}
export function draftRequest(
  input: {
    title: string;
    description: string;
    ticket: string;
    demo: boolean;
    repositories: string[];
    primary: string;
    preset: string | null;
    advanced: string;
  },
  config: RelayConfig,
): Record<string, unknown> {
  if (!input.title.trim()) throw new Error('Enter a title.');
  const advanced = jsonObject(input.advanced);
  const allowed = new Set([
    'routing',
    'models',
    'execution',
    'dependencies',
    'repositorySettings',
    'smartRouting',
  ]);
  if (Object.keys(advanced).some((key) => !allowed.has(key)))
    throw new Error(
      'Advanced options support routing, models, execution, dependencies, repositorySettings, and smartRouting.',
    );
  const selected = input.demo ? [] : input.repositories;
  if (!input.demo && !selected.length) throw new Error('Choose at least one repository.');
  if (
    new Set(selected).size !== selected.length ||
    selected.some((id) => !config.repositories.some((repo) => repo.id === id))
  )
    throw new Error('Repository selection changed. Refresh and choose again.');
  if (!input.demo && !selected.includes(input.primary))
    throw new Error('Choose a primary repository.');
  return {
    ...advanced,
    title: input.title,
    description: input.description,
    ticket: input.ticket,
    demo: input.demo,
    repositoryIds: selected,
    ...(input.demo ? {} : { repositoryId: input.primary }),
    preset: input.preset,
  };
}
