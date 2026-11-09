import { useEffect, useRef, useState } from 'react';
import { fetchStorage, type StorageReport } from './storage';
export function useStorage() {
  const [report, setReport] = useState<StorageReport | null>(null),
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
        const value = await fetchStorage(controller.signal);
        if (alive) {
          setReport(value);
          setError('');
        }
      } catch (failure) {
        if (alive && !(failure instanceof DOMException && failure.name === 'AbortError'))
          setError(failure instanceof Error ? failure.message : 'Could not inspect storage.');
      } finally {
        running = false;
        if (alive && pending) {
          pending = false;
          void refresh();
        }
      }
    }
    refreshRef.current = refresh;
    const focus = () => {
      if (!document.hidden) void refresh();
    };
    let eventTimer: number | undefined;
    const changed = () => {
      if (eventTimer !== undefined) return;
      eventTimer = window.setTimeout(() => {
        eventTimer = undefined;
        focus();
      }, 5000);
    };
    window.addEventListener('relay-data-change', changed);
    window.addEventListener('focus', focus);
    document.addEventListener('visibilitychange', focus);
    void refresh();
    const timer = window.setInterval(focus, 30000);
    return () => {
      alive = false;
      controller?.abort();
      window.clearInterval(timer);
      if (eventTimer !== undefined) window.clearTimeout(eventTimer);
      window.removeEventListener('relay-data-change', changed);
      window.removeEventListener('focus', focus);
      document.removeEventListener('visibilitychange', focus);
      if (refreshRef.current === refresh) refreshRef.current = async () => {};
    };
  }, []);
  return { report, error, refresh: () => refreshRef.current() };
}
