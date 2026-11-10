import { useEffect, useRef, useState } from 'react';
import {
  acceptResult,
  approvePlan,
  createTask,
  fetchBootstrap,
  fetchTasks,
  importIssue,
  saveConfig,
  taskAction,
  resolveBlocker,
} from './api';
import type { Bootstrap, ImportedIssue, RelayConfig, Task } from './types';

export function useRelay() {
  const [tasks, setTasks] = useState<Task[]>([]),
    [bootstrap, setBootstrap] = useState<Bootstrap | null>(null),
    [connected, setConnected] = useState(false),
    [error, setError] = useState('');
  const refreshRef = useRef<() => Promise<void>>(async () => {});
  useEffect(() => {
    let alive = true,
      running = false,
      pending = false,
      controller: AbortController | undefined;
    async function refresh() {
      if (running) {
        pending = true;
        return;
      }
      running = true;
      controller = new AbortController();
      try {
        const [nextTasks, session] = await Promise.all([
          fetchTasks(controller.signal),
          fetchBootstrap(controller.signal),
        ]);
        if (alive) {
          setTasks(nextTasks);
          setBootstrap(session);
          setError('');
        }
      } catch (failure) {
        if (alive && !(failure instanceof DOMException && failure.name === 'AbortError'))
          setError(failure instanceof Error ? failure.message : 'Could not load Relay.');
      } finally {
        running = false;
        if (alive && pending) {
          pending = false;
          void refresh();
        }
      }
    }
    refreshRef.current = refresh;
    const source = new EventSource('/api/events');
    source.onopen = () => {
      if (alive) {
        setConnected(true);
        void refresh();
      }
    };
    source.onmessage = () => {
      void refresh();
      window.dispatchEvent(new Event('relay-data-change'));
    };
    source.onerror = () => {
      if (alive) setConnected(false);
    };
    void refresh();
    const interval = window.setInterval(() => {
      if (!document.hidden) void refresh();
    }, 10000);
    return () => {
      alive = false;
      controller?.abort();
      source.close();
      window.clearInterval(interval);
      if (refreshRef.current === refresh) refreshRef.current = async () => {};
    };
  }, []);
  async function create(request: Record<string, unknown>): Promise<Task> {
    if (!bootstrap) throw new Error('Relay is still connecting.');
    try {
      const result = await createTask(bootstrap.token, request);
      setTasks((current) => [result, ...current.filter((task) => task.id !== result.id)]);
      void refreshRef.current();
      return result;
    } catch (failure) {
      void refreshRef.current();
      throw failure;
    }
  }
  async function updateConfig(revision: string, config: RelayConfig): Promise<void> {
    if (!bootstrap) throw new Error('Relay is still connecting.');
    try {
      const result = await saveConfig(bootstrap.token, revision, config);
      setBootstrap((current) =>
        current ? { ...current, config: result.config, configRevision: result.revision } : current,
      );
      void refreshRef.current();
    } catch (failure) {
      void refreshRef.current();
      throw failure;
    }
  }
  async function act(id: string, action: 'start' | 'resume' | 'pause'): Promise<Task> {
    if (!bootstrap?.workflowPreview) throw new Error('Workflow preview is unavailable.');
    try {
      const result = await taskAction(bootstrap.token, id, action);
      setTasks((current) => current.map((task) => (task.id === id ? result : task)));
      void refreshRef.current();
      return result;
    } catch (failure) {
      void refreshRef.current();
      throw failure;
    }
  }
  async function approve(
    id: string,
    optionId: string,
    note: string,
    planAttemptId: string,
    taskRevision: string,
  ): Promise<Task> {
    if (!bootstrap?.implementationPreview)
      throw new Error('Implementation preview is unavailable.');
    try {
      return await approvePlan(bootstrap.token, id, optionId, note, planAttemptId, taskRevision);
    } finally {
      void refreshRef.current();
    }
  }
  async function accept(id: string, taskRevision: string): Promise<Task> {
    if (!bootstrap?.implementationPreview)
      throw new Error('Implementation preview is unavailable.');
    try {
      return await acceptResult(bootstrap.token, id, taskRevision);
    } finally {
      void refreshRef.current();
    }
  }
  async function resolve(
    id: string,
    taskRevision: string,
    decisionId: string,
    resolution: 'retry' | 'replan' | 'pause',
    optionId: string,
    note: string,
  ): Promise<Task> {
    if (!bootstrap?.debugRecoveryPreview) throw new Error('Debugger recovery is unavailable.');
    try {
      return await resolveBlocker(
        bootstrap.token,
        id,
        taskRevision,
        decisionId,
        resolution,
        optionId,
        note,
      );
    } finally {
      void refreshRef.current();
    }
  }
  async function importTicket(
    repositoryId: string,
    ticket: string,
    signal?: AbortSignal,
  ): Promise<ImportedIssue> {
    if (!bootstrap?.issueImportPreview) throw new Error('Issue import is unavailable.');
    try {
      return await importIssue(
        bootstrap.token,
        repositoryId,
        bootstrap.configRevision,
        ticket,
        signal,
      );
    } catch (failure) {
      void refreshRef.current();
      throw failure;
    }
  }
  return {
    tasks,
    bootstrap,
    connected,
    error,
    create,
    updateConfig,
    act,
    approve,
    accept,
    resolve,
    importTicket,
    refresh: () => refreshRef.current(),
  };
}
