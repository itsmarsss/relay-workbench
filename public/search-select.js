export function prepareSearchSelects(root) {
  for (const [index, select] of [...root.querySelectorAll('select')].entries()) {
    if (select.multiple || select.size > 1 || select.closest('relay-select')) continue;
    const host = root.ownerDocument.createElement('relay-select');
    host.dataset.eventKey = `select-${select.id || select.name || index}`;
    const parent = select.parentNode;
    const next = select.nextSibling;
    host.append(select);
    parent.insertBefore(host, next);
  }
}

if (typeof customElements !== 'undefined' && !customElements.get('relay-select')) {
  document.addEventListener('click', (event) => {
    if (event.defaultPrevented) return;
    const label = event.target.closest?.('label');
    const host = label?.control?.closest('relay-select');
    if (!host || event.target.closest('a,button,input,textarea')) return;
    event.preventDefault();
    host.trigger.focus({ preventScroll: true });
    host.open();
  });
  let sequence = 0;
  customElements.define(
    'relay-select',
    class extends HTMLElement {
      constructor() {
        super();
        this.attachShadow({ mode: 'open' });
        this.uid = `search-select-${++sequence}`;
        this.shadowRoot.innerHTML = `<link rel="stylesheet" href="/search-select.css"><button type="button" class="select-trigger" role="combobox" aria-haspopup="listbox" aria-expanded="false"><span class="select-value"></span><span class="select-chevron" aria-hidden="true">⌄</span></button><div class="select-popover" popover="manual"><div class="select-search"><input type="search" autocomplete="off" placeholder="Search options…" role="combobox" aria-autocomplete="list" aria-expanded="true"></div><div class="select-options" role="listbox"></div><div class="select-status" role="status" aria-live="polite"></div></div>`;
        this.trigger = this.shadowRoot.querySelector('button');
        this.panel = this.shadowRoot.querySelector('.select-popover');
        this.search = this.shadowRoot.querySelector('input');
        this.list = this.shadowRoot.querySelector('[role=listbox]');
        this.list.id = this.uid;
        this.trigger.setAttribute('aria-controls', this.uid);
        this.search.setAttribute('aria-controls', this.uid);
        this.trigger.addEventListener('click', (event) => {
          event.preventDefault();
          this.opened ? this.close() : this.open();
        });
        this.trigger.addEventListener('keydown', (event) => {
          if (
            event.key.length === 1 &&
            event.key !== ' ' &&
            !event.ctrlKey &&
            !event.metaKey &&
            !event.altKey
          ) {
            event.preventDefault();
            event.stopPropagation();
            this.open();
            this.search.value = event.key;
            this.activeIndex = null;
            this.renderOptions();
            return;
          }
          if (['ArrowDown', 'ArrowUp'].includes(event.key)) {
            event.preventDefault();
            event.stopPropagation();
            this.open(event.key === 'ArrowUp' ? -1 : 1);
          }
        });
        this.search.addEventListener('input', () => {
          this.activeIndex = null;
          this.renderOptions();
        });
        this.search.addEventListener('keydown', (event) => {
          event.stopPropagation();
          if (['ArrowDown', 'ArrowUp', 'Enter', 'Escape'].includes(event.key)) {
            event.preventDefault();
            event.stopPropagation();
            if (event.key === 'Escape') this.close(true);
            else if (event.key === 'Enter') this.choose(this.activeIndex);
            else this.move(event.key === 'ArrowUp' ? -1 : 1);
          } else if (event.key === 'Tab') this.close(true);
        });
        this.list.addEventListener('pointerdown', (event) => event.preventDefault());
        this.list.addEventListener('click', (event) => {
          event.preventDefault();
          event.stopPropagation();
          const option = event.target.closest('[data-option-index]');
          if (option) this.choose(Number(option.dataset.optionIndex));
        });
      }
      connectedCallback() {
        this.select = this.querySelector('select');
        if (!this.select) return;
        this.listeners?.abort();
        this.listeners = new AbortController();
        const { signal } = this.listeners;
        this.select.addEventListener('change', () => this.sync(), { signal });
        this.select.addEventListener(
          'invalid',
          (event) => {
            event.preventDefault();
            this.trigger.setAttribute('aria-invalid', 'true');
            this.trigger.focus();
          },
          { signal },
        );
        this.select.addEventListener('focus', () => this.trigger.focus(), { signal });
        document.addEventListener(
          'pointerdown',
          (event) => {
            if (this.opened && !event.composedPath().includes(this)) this.close();
          },
          { signal, capture: true },
        );
        this.addEventListener(
          'focusout',
          () =>
            queueMicrotask(() => {
              if (this.opened && !this.shadowRoot.activeElement) this.close();
            }),
          { signal },
        );
        window.addEventListener('resize', () => this.position(), { signal });
        document.addEventListener('scroll', () => this.position(), { signal, capture: true });
        this.observer?.disconnect();
        this.observer = new MutationObserver(() => this.sync());
        this.observer.observe(this.select, {
          subtree: true,
          attributes: true,
          childList: true,
          characterData: true,
        });
        this.sync();
      }
      disconnectedCallback() {
        this.close();
        this.observer?.disconnect();
        this.listeners?.abort();
      }
      get opened() {
        return this.panel.matches(':popover-open');
      }
      label() {
        const label = this.select.labels?.[0];
        if (label) {
          const copy = label.cloneNode(true);
          copy
            .querySelectorAll('relay-select, select, input, textarea, small')
            .forEach((node) => node.remove());
          const text = copy.textContent.replace(/\s+/g, ' ').trim();
          if (text) return text;
        }
        return this.select.getAttribute('aria-label') || this.select.name || 'Choose an option';
      }
      sync() {
        if (!this.select) return;
        const label = this.label();
        this.trigger.setAttribute('aria-label', label);
        this.trigger.setAttribute('aria-required', String(this.select.required));
        this.trigger.disabled = this.select.matches(':disabled');
        this.shadowRoot.querySelector('.select-value').textContent =
          this.select.selectedOptions[0]?.label || 'Choose an option';
        this.search.setAttribute('aria-label', `Search ${label}`);
        this.list.setAttribute('aria-label', label);
        if (this.select.validity.valid) this.trigger.removeAttribute('aria-invalid');
        if (this.trigger.disabled) this.close();
        else if (this.opened) {
          const index = [...this.select.options].findIndex(
            (option) => option.value === this.activeValue,
          );
          if (index >= 0) this.activeIndex = index;
          this.renderOptions();
          this.position();
        }
      }
      open(direction = 1) {
        if (this.trigger.disabled || !this.select) return;
        this.search.value = '';
        this.activeIndex = this.select.selectedIndex;
        this.panel.showPopover();
        this.trigger.setAttribute('aria-expanded', 'true');
        this.renderOptions();
        if (!this.enabled.some((item) => item.index === this.activeIndex)) this.move(direction);
        this.position();
        this.search.focus({ preventScroll: true });
      }
      close(focus = false) {
        if (this.opened) this.panel.hidePopover();
        this.trigger.setAttribute('aria-expanded', 'false');
        if (focus && this.isConnected) this.trigger.focus({ preventScroll: true });
      }
      renderOptions() {
        const scrollTop = this.list.scrollTop;
        const query = this.search.value.trim().toLocaleLowerCase();
        const options = [...this.select.options]
          .map((option, index) => ({ option, index }))
          .filter(
            ({ option }) => !option.hidden && option.label.toLocaleLowerCase().includes(query),
          );
        const custom = this.search.value.trim();
        if (
          this.select.hasAttribute('data-allow-custom') &&
          custom &&
          custom.length <= 200 &&
          ![...this.select.options].some(
            (option) => option.value.toLocaleLowerCase() === custom.toLocaleLowerCase(),
          )
        ) {
          options.push({
            option: {
              label: `Use “${custom}”`,
              value: custom,
              selected: false,
              disabled: false,
              closest: () => null,
            },
            index: -1,
          });
        }
        this.enabled = options.filter(
          ({ option }) => !option.disabled && !option.closest('optgroup')?.disabled,
        );
        if (!this.enabled.some((item) => item.index === this.activeIndex))
          this.activeIndex = this.enabled[0]?.index ?? null;
        const fragment = document.createDocumentFragment();
        for (const { option, index } of options) {
          const row = document.createElement('div');
          row.id = `${this.uid}-${index}`;
          row.dataset.optionIndex = index;
          row.className = `select-option${index === this.activeIndex ? ' active' : ''}`;
          row.setAttribute('role', 'option');
          row.setAttribute('aria-selected', String(option.selected));
          row.setAttribute(
            'aria-disabled',
            String(option.disabled || option.closest('optgroup')?.disabled === true),
          );
          row.textContent = option.label;
          fragment.append(row);
        }
        this.list.replaceChildren(fragment);
        this.list.scrollTop = scrollTop;
        this.activeValue = this.select.options[this.activeIndex]?.value;
        this.shadowRoot.querySelector('.select-status').textContent = options.length
          ? `${options.length} ${options.length === 1 ? 'option' : 'options'}`
          : 'No matching options';
        if (this.activeIndex !== null)
          this.search.setAttribute('aria-activedescendant', `${this.uid}-${this.activeIndex}`);
        else this.search.removeAttribute('aria-activedescendant');
      }
      move(direction) {
        if (!this.enabled?.length) return;
        const current = this.enabled.findIndex((item) => item.index === this.activeIndex);
        this.activeIndex =
          this.enabled[(current + direction + this.enabled.length) % this.enabled.length].index;
        this.renderOptions();
        this.shadowRoot
          .getElementById(`${this.uid}-${this.activeIndex}`)
          ?.scrollIntoView({ block: 'nearest' });
      }
      choose(index) {
        if (
          index === -1 &&
          this.select.hasAttribute('data-allow-custom') &&
          !this.select.matches(':disabled')
        ) {
          const value = this.search.value.trim();
          if (!value || value.length > 200) return;
          const option = new Option(value, value);
          this.select.add(option);
          index = option.index;
        }
        const option = this.select.options[index];
        if (
          index === null ||
          !option ||
          this.select.matches(':disabled') ||
          option.disabled ||
          option.closest('optgroup')?.disabled
        )
          return;
        this.select.selectedIndex = index;
        this.close(true);
        this.sync();
        this.select.dispatchEvent(new Event('input', { bubbles: true }));
        this.select.dispatchEvent(new Event('change', { bubbles: true }));
      }
      position() {
        if (!this.opened || !this.isConnected) return;
        const rect = this.trigger.getBoundingClientRect();
        const margin = 10;
        const width = Math.min(Math.max(rect.width, 240), innerWidth - margin * 2);
        const below = innerHeight - rect.bottom - margin;
        const above = rect.top - margin;
        const up = below < 230 && above > below;
        const height = Math.min(360, Math.max(120, up ? above - 6 : below - 6));
        this.panel.style.width = `${width}px`;
        this.panel.style.maxHeight = `${height}px`;
        this.panel.style.left = `${Math.max(margin, Math.min(rect.left, innerWidth - width - margin))}px`;
        this.panel.style.top = `${up ? Math.max(margin, rect.top - Math.min(this.panel.scrollHeight, height) - 6) : rect.bottom + 6}px`;
      }
    },
  );
}
