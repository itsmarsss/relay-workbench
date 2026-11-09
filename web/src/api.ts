import { isConfig, isTask, type Bootstrap, type RelayConfig, type Task } from './types.ts';
export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}
async function json(response: Response): Promise<unknown> {
  let result: unknown;
  try {
    result = await response.json();
  } catch {
    throw new ApiError('Relay returned an invalid response.', response.status);
  }
  if (!response.ok) {
    const message =
      result && typeof result === 'object' && 'error' in result && typeof result.error === 'string'
        ? result.error
        : `Request failed (${response.status}).`;
    throw new ApiError(message, response.status);
  }
  return result;
}
export async function fetchTasks(signal?: AbortSignal): Promise<Task[]> {
  const result = await json(
    await fetch('/api/tasks', { signal, headers: { Accept: 'application/json' } }),
  );
  if (!Array.isArray(result) || !result.every(isTask)) throw new Error('Task data is invalid.');
  return result;
}
export async function fetchBootstrap(signal?: AbortSignal): Promise<Bootstrap> {
  const result = await json(
    await fetch('/api/bootstrap', { signal, headers: { Accept: 'application/json' } }),
  );
  if (
    !result ||
    typeof result !== 'object' ||
    !('token' in result) ||
    typeof result.token !== 'string' ||
    !/^[a-f0-9]{64}$/.test(result.token) ||
    !('configRevision' in result) ||
    typeof result.configRevision !== 'string' ||
    !/^[a-f0-9]{64}$/.test(result.configRevision) ||
    !('config' in result) ||
    !isConfig(result.config)
  )
    throw new Error('Relay configuration is invalid.');
  return {
    token: result.token,
    config: result.config,
    configRevision: result.configRevision,
    workflowPreview: 'workflowPreview' in result && result.workflowPreview === true,
  };
}
export async function taskAction(
  token: string,
  id: string,
  action: 'start' | 'resume' | 'pause',
): Promise<Task> {
  const result = await json(
    await fetch(`/api/tasks/${encodeURIComponent(id)}/${action}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Relay-Token': token },
      body: '{}',
    }),
  );
  if (!isTask(result)) throw new Error('Updated task data is invalid.');
  return result;
}
export async function createTask(token: string, request: Record<string, unknown>): Promise<Task> {
  const result = await json(
    await fetch('/api/tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Relay-Token': token },
      body: JSON.stringify(request),
    }),
  );
  if (!isTask(result)) throw new Error('Created task data is invalid.');
  return result;
}
export async function saveConfig(
  token: string,
  revision: string,
  config: RelayConfig,
): Promise<{ config: RelayConfig; revision: string }> {
  const result = await json(
    await fetch('/api/config', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'X-Relay-Token': token, 'If-Match': revision },
      body: JSON.stringify(config),
    }),
  );
  if (
    !result ||
    typeof result !== 'object' ||
    !('config' in result) ||
    !isConfig(result.config) ||
    !('revision' in result) ||
    typeof result.revision !== 'string' ||
    !/^[a-f0-9]{64}$/.test(result.revision)
  )
    throw new Error('Saved configuration is invalid.');
  return { config: result.config, revision: result.revision };
}
