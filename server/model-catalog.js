import { runProcess } from './process.js';
import { fileURLToPath } from 'node:url';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
export function normalizeModels(provider, values) {
  const models = new Map();
  for (const item of Array.isArray(values) ? values : []) {
    if (!item || typeof item !== 'object' || item.hidden) continue;
    const raw = item.model ?? item.value ?? item.id;
    if (typeof raw !== 'string' || !raw.trim() || raw.length > 200) continue;
    const id =
      provider === 'pi' && typeof item.provider === 'string' ? `${item.provider}/${raw}` : raw;
    if (id.length > 200) continue;
    const efforts = Array.isArray(item.supportedEffortLevels)
      ? item.supportedEffortLevels
      : Array.isArray(item.supportedReasoningEfforts)
        ? item.supportedReasoningEfforts.map((e) => e?.reasoningEffort)
        : [];
    models.set(id, {
      id,
      name: String(item.displayName ?? item.display_name ?? item.name ?? id).slice(0, 200),
      efforts: efforts.filter((e) => typeof e === 'string'),
    });
    if (models.size >= 2000) break;
  }
  return [...models.values()];
}
export class ModelCatalog {
  constructor({ run = runProcess, ttl = 300000 } = {}) {
    this.run = run;
    this.ttl = ttl;
    this.cache = new Map();
    this.pending = new Map();
    this.controllers = new Set();
  }
  async provider(provider, config, force = false) {
    const key = JSON.stringify([provider, config.command]);
    const saved = this.cache.get(key);
    if (!force && saved && Date.now() - saved.at < this.ttl) return saved.value;
    if (this.pending.has(key)) return this.pending.get(key);
    const work = (async () => {
      const controller = new AbortController();
      this.controllers.add(controller);
      let directory;
      try {
        directory = await mkdtemp(join(tmpdir(), 'relay-models-'));
        const result = await this.run(
          process.execPath,
          [
            fileURLToPath(new URL('./model-probe.js', import.meta.url)),
            JSON.stringify({ provider, command: config.command }),
          ],
          { cwd: directory, timeout: 22000, maxBytes: 2e6, signal: controller.signal },
        );
        const data = JSON.parse(result.stdout.trim());
        if (result.code !== 0 || data.error) throw Error(data.error || 'Model discovery failed');
        const models = normalizeModels(provider, data.models);
        const value = {
          models,
          status: models.length ? 'ready' : 'empty',
          checkedAt: new Date().toISOString(),
        };
        this.cache.set(key, { at: Date.now(), value });
        return value;
      } catch (error) {
        const value = {
          models: saved?.value.models ?? [],
          status: 'unavailable',
          error: error.message.slice(0, 300),
          checkedAt: new Date().toISOString(),
        };
        this.cache.set(key, { at: Date.now() - this.ttl + 30000, value });
        return value;
      } finally {
        this.controllers.delete(controller);
        if (directory) await rm(directory, { recursive: true, force: true });
      }
    })().finally(() => this.pending.delete(key));
    this.pending.set(key, work);
    return work;
  }
  async discover(harnesses, force = false) {
    return Object.fromEntries(
      await Promise.all(
        Object.entries(harnesses).map(async ([id, config]) => [
          id,
          await this.provider(id, config, force),
        ]),
      ),
    );
  }
  async stop() {
    for (const controller of this.controllers) controller.abort();
    await Promise.allSettled([...this.pending.values()]);
  }
}
