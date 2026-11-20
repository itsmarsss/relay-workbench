import { Select, ProviderIcon, providerName } from './UI';
import { useResource } from './Session';
import { EffortSelect, ModelSelect } from './WorkspacePages';
import { asObject } from './task-data';
import type { RelayConfig } from './types';

export type AgentOptions = {
  routing: Record<string, string>;
  models: Record<string, string>;
  efforts: Record<string, string>;
  execution: Record<string, number>;
  smartRouting: boolean;
};
export function agentOptions(value: Record<string, unknown> = {}): AgentOptions {
  return {
    routing: { ...asObject(value.routing) } as Record<string, string>,
    models: { ...asObject(value.models) } as Record<string, string>,
    efforts: { ...asObject(value.efforts) } as Record<string, string>,
    execution: { ...asObject(value.execution) } as Record<string, number>,
    smartRouting: value.smartRouting === true,
  };
}
const stages = [
  ['triage', 'Routing', 'Chooses agents for the task'],
  ['investigate', 'Investigation', 'Reproduction, evidence and affected files'],
  ['plan', 'Planning', 'Approaches, tradeoffs and recommendation'],
  ['implement', 'Implementation', 'Source changes and supervised verification'],
  ['review', 'Review', 'Independent review of the result'],
];
export function AgentSettings({
  config,
  value,
  onChange,
}: {
  config: RelayConfig;
  value: AgentOptions;
  onChange: (next: AgentOptions) => void;
}) {
  const routing = asObject(config.routing) || {};
  // Which agents answer on this machine, as on the Agents page.
  const catalog = useResource<Record<string, unknown>>('/api/models');
  const unavailable = (id: string) =>
    asObject(asObject(config.harnesses)?.[id])?.enabled === false ||
    (!!catalog.data && asObject(catalog.data[id])?.status !== 'ready');
  return (
    <div className="task-agent-settings">
      <label className="check-row">
        <input
          type="checkbox"
          checked={value.smartRouting}
          onChange={(e) => onChange({ ...value, smartRouting: e.target.checked })}
        />
        Let the routing agent recommend specialists
      </label>
      <div className="stage-agent-list">
        {stages
          .filter(([id]) => id !== 'triage' || value.smartRouting)
          .map(([id = '', title, hint]) => {
            const provider = value.routing[id] || String(routing[id] || 'codex');
            return (
              <fieldset key={id} className="stage-agent-row">
                <legend>{title}</legend>
                <p className="form-note">{hint}</p>
                <div className="agent-field-grid">
                  <label className="field">
                    Agent
                    <Select
                      label={`${title} agent`}
                      value={provider}
                      options={['codex', 'claude', 'pi'].map((value) => ({
                        value,
                        label: value === 'pi' ? 'Pi' : value === 'codex' ? 'Codex' : 'Claude',
                        icon: <ProviderIcon provider={value} size={22} />,
                        disabled: asObject(asObject(config.harnesses)?.[value])?.enabled === false,
                      }))}
                      onChange={(provider) =>
                        onChange({
                          ...value,
                          routing: { ...value.routing, [id]: provider },
                          models: { ...value.models, [id]: '' },
                          efforts: { ...value.efforts, [id]: '' },
                        })
                      }
                    />
                    {unavailable(provider) && (
                      <small className="agent-state" data-state="missing">
                        {providerName(provider)} isn't available here, so an installed agent runs
                        this stage
                      </small>
                    )}
                  </label>
                  <label className="field">
                    Model
                    <ModelSelect
                      provider={provider}
                      value={value.models[id] || ''}
                      onChange={(model) =>
                        onChange({ ...value, models: { ...value.models, [id]: model } })
                      }
                    />
                  </label>
                  <label className="field">
                    Effort
                    <EffortSelect
                      provider={provider}
                      value={value.efforts[id] || ''}
                      onChange={(effort) =>
                        onChange({ ...value, efforts: { ...value.efforts, [id]: effort } })
                      }
                    />
                  </label>
                </div>
              </fieldset>
            );
          })}
      </div>
      <fieldset>
        <legend>Execution limits</legend>
        <div className="agent-field-grid">
          {(
            [
              ['timeoutMinutes', 'Stage budget (minutes)', 1, 240],
              ['maxRepairRounds', 'Automatic repair rounds', 1, 10],
              ['maxRecoveryAttempts', 'Blocker recovery attempts', 0, 5],
            ] as const
          ).map(([key, label, min, max]) => (
            <label className="field" key={key}>
              {label}
              <input
                type="number"
                min={min}
                max={max}
                required
                value={value.execution[key] ?? Number(config[key] ?? min)}
                onChange={(e) =>
                  onChange({
                    ...value,
                    execution: { ...value.execution, [key]: e.target.valueAsNumber },
                  })
                }
              />
            </label>
          ))}
        </div>
      </fieldset>
    </div>
  );
}
