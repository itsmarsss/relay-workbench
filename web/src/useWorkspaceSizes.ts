import { useEffect, useState } from 'react';
import { request, useSession } from './Session';
export type WorkspaceSize = { allocatedBytes: string; complete: boolean; measuredAt: string };
type Report = { sizes: Record<string, WorkspaceSize>; measuring: string[]; pending: number };
// Disk use per task. The service measures in the background, so this asks again soon while
// anything is still being measured and rarely once everything is known.
export function useWorkspaceSizes() {
  const token = useSession().bootstrap?.token;
  const [report, setReport] = useState<Report>({ sizes: {}, measuring: [], pending: 0 });
  useEffect(() => {
    if (!token) return;
    let alive = true,
      timer: number | undefined;
    const controller = new AbortController();
    async function load() {
      let wait = 60000;
      try {
        const value = await request<Report>(
          '/api/workspaces/sizes',
          token,
          undefined,
          'GET',
          controller.signal,
        );
        if (!alive) return;
        if (
          value &&
          typeof value.sizes === 'object' &&
          value.sizes &&
          Array.isArray(value.measuring)
        ) {
          setReport(value);
          if (value.pending > 0) wait = 4000;
        }
      } catch {}
      if (alive) timer = window.setTimeout(load, document.hidden ? 60000 : wait);
    }
    void load();
    return () => {
      alive = false;
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [token]);
  return report;
}
