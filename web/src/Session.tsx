import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { isTask, type Bootstrap } from './types';
const Session = createContext<{ bootstrap: Bootstrap | null; refresh: () => Promise<void> }>({
  bootstrap: null,
  refresh: async () => {},
});
export const SessionProvider = Session.Provider;
export function useSession() {
  return useContext(Session);
}
export async function request<T = Record<string, unknown>>(
  path: string,
  token?: string,
  body?: unknown,
  method = body === undefined ? 'GET' : 'POST',
  signal?: AbortSignal,
): Promise<T> {
  const response = await fetch(path, {
    method,
    signal,
    headers: {
      Accept: 'application/json',
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(token ? { 'X-Relay-Token': token } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const value: unknown = await response.json();
  if (!response.ok)
    throw new Error(
      value && typeof value === 'object' && 'error' in value
        ? String(value.error)
        : `Request failed (${response.status})`,
    );
  return value as T;
}
export function useResource<T>(path: string | null) {
  const [data, setData] = useState<T | null>(null),
    [error, setError] = useState(''),
    [loading, setLoading] = useState(true);
  const { bootstrap } = useSession(),
    token = bootstrap?.token,
    refreshRef = useRef<() => Promise<void>>(async () => {});
  useEffect(() => {
    if (!path) {
      setData(null);
      setLoading(false);
      return;
    }
    let alive = true,
      running = false,
      pending = false,
      generation = 0;
    let controller: AbortController | undefined, timer: number | undefined;
    async function load() {
      if (running) {
        pending = true;
        return;
      }
      running = true;
      const started = generation;
      controller = new AbortController();
      try {
        const value = await request<T>(path!, token, undefined, 'GET', controller.signal);
        if (alive && started === generation) {
          setData(value);
          setError('');
        }
      } catch (e) {
        if (alive && !(e instanceof DOMException && e.name === 'AbortError'))
          setError(e instanceof Error ? e.message : 'Could not load data');
      } finally {
        running = false;
        if (alive) {
          setLoading(false);
          if (pending) {
            pending = false;
            void load();
          }
        }
      }
    }
    function changed() {
      if (timer === undefined)
        timer = window.setTimeout(() => {
          timer = undefined;
          void load();
        }, 180);
    }
    function updated(event: Event) {
      const task = (event as CustomEvent).detail;
      if (isTask(task) && path === `/api/tasks/${task.id}`) {
        generation++;
        setData(task as T);
      }
    }
    setData(null);
    setError('');
    setLoading(true);
    void load();
    refreshRef.current = load;
    window.addEventListener('relay-data-change', changed);
    window.addEventListener('relay-task-update', updated);
    const interval = window.setInterval(() => {
      if (!document.hidden) changed();
    }, 10000);
    return () => {
      alive = false;
      controller?.abort();
      window.clearTimeout(timer);
      window.clearInterval(interval);
      window.removeEventListener('relay-data-change', changed);
      window.removeEventListener('relay-task-update', updated);
    };
  }, [path, token]);
  return { data, error, loading, refresh: () => refreshRef.current() };
}
export function useMutation() {
  const { bootstrap, refresh } = useSession();
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const pending = useRef(false);
  const run = useCallback(
    async <T,>(path: string, body: unknown, method = 'POST'): Promise<T> => {
      if (!bootstrap) throw new Error('Relay is connecting');
      if (pending.current) throw new Error('Wait for the current action');
      pending.current = true;
      setBusy(true);
      setError('');
      try {
        const value = await request<T>(path, bootstrap.token, body, method);
        if (isTask(value))
          window.dispatchEvent(new CustomEvent('relay-task-update', { detail: value }));
        window.dispatchEvent(new Event('relay-data-change'));
        void refresh();
        return value;
      } catch (e) {
        const message = e instanceof Error ? e.message : 'Action failed';
        setError(message);
        throw e;
      } finally {
        pending.current = false;
        setBusy(false);
      }
    },
    [bootstrap, refresh],
  );
  return { run, busy, error, clearError: () => setError('') };
}
export function Notice({ children }: { children: ReactNode }) {
  return (
    <p className="error" role="alert">
      {children}
    </p>
  );
}
