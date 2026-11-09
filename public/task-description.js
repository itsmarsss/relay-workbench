const entries = new WeakMap();
const observed = new Set();
export function syncTaskDescriptions(root) {
  for (const section of observed) {
    if (!section.isConnected) {
      entries.get(section).observer.disconnect();
      entries.delete(section);
      observed.delete(section);
    }
  }
  for (const section of root.querySelectorAll('.task-details')) {
    const body = section.querySelector('.task-description');
    const button = section.querySelector('.description-toggle');
    if (!body || !button) continue;
    let entry = entries.get(section);
    if (!entry) {
      entry = { expanded: false };
      entries.set(section, entry);
      observed.add(section);
      entry.sync = () => {
        section.classList.toggle('description-expanded', entry.expanded);
        const overflowing = body.scrollHeight > (entry.expanded ? 420 : body.clientHeight) + 1;
        button.hidden = !entry.expanded && !overflowing;
        button.setAttribute('aria-expanded', String(entry.expanded));
        button.textContent = entry.expanded ? 'Collapse description' : 'Expand description';
      };
      entry.observer = new ResizeObserver(entry.sync);
      entry.observer.observe(body);
      button.addEventListener('click', () => {
        entry.expanded = !entry.expanded;
        entry.sync();
      });
    }
    entry.sync();
  }
}
