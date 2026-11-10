import { useMemo } from 'react';
import { fieldChanges, textChanges } from './changes';
export function ReviewChanges({
  before,
  after,
}: {
  before?: Record<string, unknown>;
  after: Record<string, unknown>;
}) {
  const fields = useMemo(() => fieldChanges(before || {}, after), [before, after]);
  return (
    <div className="proposal-diff">
      {fields.map((field) => (
        <section key={field.path}>
          <h4>{field.path}</h4>
          <div className="proposal-diff-text">
            {textChanges(field.before, field.after).map((part, index) =>
              part.kind === 'added' ? (
                <ins key={index}>{part.text}</ins>
              ) : part.kind === 'removed' ? (
                <del key={index}>{part.text}</del>
              ) : (
                <span key={index}>{part.text}</span>
              ),
            )}
          </div>
        </section>
      ))}
      {!fields.length && <p>No field changes.</p>}
    </div>
  );
}
