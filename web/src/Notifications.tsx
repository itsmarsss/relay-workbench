import { useEffect, useRef, useState } from 'react';
import type { Task } from './types';
const key = 'relay-desktop-notifications';
function enabled() {
  try {
    return localStorage.getItem(key) === 'true';
  } catch {
    return false;
  }
}
export function useTaskNotifications(tasks: Task[], ready: boolean) {
  const previous = useRef<Map<string, string> | null>(null);
  useEffect(() => {
    if (!ready) return;
    const next = new Map(
      tasks.map((task) => [task.id, `${task.status}:${task.currentRun?.id || ''}`]),
    );
    const old = previous.current;
    previous.current = next;
    if (
      !old ||
      !enabled() ||
      typeof Notification === 'undefined' ||
      Notification.permission !== 'granted'
    )
      return;
    for (const task of tasks) {
      const signature = next.get(task.id)!;
      if (
        old.get(task.id) === signature ||
        !['awaiting_plan', 'awaiting_final', 'blocked', 'completed'].includes(task.status)
      )
        continue;
      const seenKey = `${key}:seen:${task.id}`;
      try {
        if (localStorage.getItem(seenKey) === signature) continue;
        localStorage.setItem(seenKey, signature);
      } catch {}
      const label = (
        {
          awaiting_plan: 'Choose an approach',
          awaiting_final: 'Final review',
          blocked: 'Needs your decision',
          completed: 'Pipeline done',
        } as Record<string, string>
      )[task.status];
      try {
        const notice = new Notification(`${label} · ${task.title}`, {
          body: (
            task.latestSummary ||
            task.error ||
            'Open Relay to review the recorded result.'
          ).slice(0, 240),
          tag: `relay-${task.id}`,
        });
        notice.onclick = () => {
          window.focus();
          location.hash = `task/${task.id}/overview`;
          notice.close();
        };
      } catch {
        /* Browsers can reject notifications after permission is revoked. */
      }
    }
  }, [tasks, ready]);
}
export function NotificationSettings() {
  const [active, setActive] = useState(enabled),
    [message, setMessage] = useState(''),
    [busy, setBusy] = useState(false);
  async function toggle() {
    if (busy) return;
    if (active) {
      try {
        localStorage.setItem(key, 'false');
      } catch {}
      setActive(false);
      return;
    }
    if (typeof Notification === 'undefined') {
      setMessage('Desktop notifications are unavailable in this browser.');
      return;
    }
    setBusy(true);
    try {
      const permission = await Notification.requestPermission();
      if (permission !== 'granted') {
        setMessage('Notifications are blocked in browser permissions.');
        return;
      }
      localStorage.setItem(key, 'true');
      setActive(true);
      setMessage('');
    } catch {
      setMessage('Could not enable notifications. Check browser permissions.');
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="surface notification-settings">
      <div className="section-heading">
        <div>
          <h2>Notifications</h2>
          <p>Decisions and completed pipelines, while Relay is open.</p>
        </div>
        <button type="button" disabled={busy} aria-pressed={active} onClick={() => void toggle()}>
          {active ? 'Disable notifications' : 'Enable notifications'}
        </button>
      </div>
      {message && <p role="status">{message}</p>}
    </section>
  );
}
