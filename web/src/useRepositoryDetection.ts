import { useEffect, useRef, useState } from 'react';
import { request, useSession } from './Session';
export type ProfileSuggestion = {
  field: 'name' | 'path' | 'cwd' | 'checks' | 'setup';
  label: string;
  value: string | { command: string; args: string[] };
  evidence: string;
};
export type RepositoryDetection = {
  root: string;
  cwd: string;
  guidance: string[];
  suggestions: ProfileSuggestion[];
};
export function parseDetection(value: unknown): RepositoryDetection {
  if (!value || typeof value !== 'object') throw Error('Invalid repository detection response.');
  const data = value as Record<string, unknown>;
  if (
    typeof data.root !== 'string' ||
    typeof data.cwd !== 'string' ||
    !Array.isArray(data.suggestions)
  )
    throw Error('Invalid repository detection response.');
  const suggestions: ProfileSuggestion[] = data.suggestions.map((item) => {
    if (!item || typeof item !== 'object') throw Error('Invalid repository suggestion.');
    const row = item as Record<string, unknown>;
    if (
      !['name', 'path', 'cwd', 'checks', 'setup'].includes(String(row.field)) ||
      typeof row.label !== 'string' ||
      typeof row.evidence !== 'string'
    )
      throw Error('Invalid repository suggestion.');
    if (row.field === 'checks' || row.field === 'setup') {
      const command = row.value as Record<string, unknown> | null;
      if (
        !command ||
        typeof command.command !== 'string' ||
        !Array.isArray(command.args) ||
        !command.args.every((arg) => typeof arg === 'string')
      )
        throw Error('Invalid suggested command.');
    } else if (typeof row.value !== 'string') throw Error('Invalid suggested value.');
    return row as ProfileSuggestion;
  });
  if (
    data.guidance !== undefined &&
    (!Array.isArray(data.guidance) || !data.guidance.every((file) => typeof file === 'string'))
  )
    throw Error('Invalid detected guidance.');
  return {
    root: data.root,
    cwd: data.cwd,
    guidance: (data.guidance as string[]) || [],
    suggestions,
  };
}
export function useRepositoryDetection(path: string, cwd: string) {
  const { bootstrap } = useSession();
  const [result, setResult] = useState<RepositoryDetection | null>(null),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  const current = useRef({ path, cwd, token: bootstrap?.token }),
    controller = useRef<AbortController>(),
    generation = useRef(0);
  current.current = { path, cwd, token: bootstrap?.token };
  async function detect() {
    const input = current.current;
    if (!input.path.trim() || !input.token) return;
    controller.current?.abort();
    const signal = (controller.current = new AbortController()).signal,
      version = ++generation.current;
    setBusy(true);
    setError('');
    try {
      const response = parseDetection(
        await request(
          '/api/repositories/suggestions',
          input.token,
          { path: input.path.trim(), cwd: input.cwd.trim() || '.' },
          'POST',
          signal,
        ),
      );
      if (signal.aborted || version !== generation.current) return;
      setResult(response);
    } catch (error) {
      if (!signal.aborted && version === generation.current)
        setError(error instanceof Error ? error.message : 'Could not detect settings.');
    } finally {
      if (!signal.aborted && version === generation.current) setBusy(false);
    }
  }
  useEffect(() => {
    generation.current++;
    controller.current?.abort();
    setResult(null);
    setError('');
    setBusy(false);
    const timer = window.setTimeout(() => void detect(), 500);
    return () => {
      window.clearTimeout(timer);
      generation.current++;
      controller.current?.abort();
    };
  }, [path, cwd, bootstrap?.token]);
  return { result, error, busy, detect };
}
