import { asObject } from './task-data';
export type Command = { command: string; args: string[] };
export function CommandEditor({
  label,
  value,
  onChange,
}: {
  label: string;
  value: Command;
  onChange: (value: Command) => void;
}) {
  return (
    <div className="command-editor">
      <label className="field">
        Executable
        <input
          aria-label={`${label} executable`}
          value={value.command}
          maxLength={1000}
          onChange={(event) => onChange({ ...value, command: event.target.value })}
          placeholder="Executable name or absolute path"
        />
      </label>
      <div className="section-heading">
        <h4>Arguments</h4>
        <button
          type="button"
          disabled={value.args.length >= 100}
          onClick={() => onChange({ ...value, args: [...value.args, ''] })}
        >
          Add argument
        </button>
      </div>
      {value.args.map((arg, index) => (
        <div className="command-argument" key={index}>
          <span className="muted">{index + 1}</span>
          <textarea
            rows={1}
            aria-label={`${label} argument ${index + 1}`}
            maxLength={19999}
            value={arg}
            onChange={(event) =>
              onChange({
                ...value,
                args: value.args.map((item, i) => (i === index ? event.target.value : item)),
              })
            }
          />
          <button
            type="button"
            className="text-button danger"
            aria-label={`Remove ${label} argument ${index + 1}`}
            onClick={() => onChange({ ...value, args: value.args.filter((_, i) => i !== index) })}
          >
            Remove
          </button>
        </div>
      ))}
      {!value.args.length && (
        <p className="form-note">Each argument is passed literally. No shell parsing.</p>
      )}
    </div>
  );
}
export function CommandListEditor({
  label,
  value,
  onChange,
}: {
  label: string;
  value: unknown[];
  onChange: (value: unknown[]) => void;
}) {
  return (
    <section className="command-list-editor">
      <div className="section-heading">
        <h3>{label}</h3>
        <button
          type="button"
          disabled={value.length >= 30}
          onClick={() => onChange([...value, { command: '', args: [] }])}
        >
          Add command
        </button>
      </div>
      {value.map((item, index) => {
        const row = asObject(item);
        const command: Command = {
          command: typeof row?.command === 'string' ? row.command : '',
          args: Array.isArray(row?.args) ? row.args.map(String) : [],
        };
        return (
          <fieldset key={index}>
            <legend>
              {label} {index + 1}
            </legend>
            <CommandEditor
              label={`${label} ${index + 1}`}
              value={command}
              onChange={(command) =>
                onChange(value.map((item, i) => (i === index ? command : item)))
              }
            />
            <button
              type="button"
              className="text-button danger"
              onClick={() => onChange(value.filter((_, i) => i !== index))}
            >
              Remove command
            </button>
          </fieldset>
        );
      })}
      {!value.length && <p className="placeholder">No commands configured.</p>}
    </section>
  );
}
