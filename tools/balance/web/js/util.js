/** Small DOM and data helpers shared by every tab. */

/**
 * Create an element.
 * Attributes: `class`, `style` (string), `dataset` (object), `on` (event map), `value`/`checked`/`disabled`
 * as properties, everything else as attributes (`false`/`null`/`undefined` skip the attribute).
 * @param {string} tag
 * @param {Record<string, any>|null} [attrs]
 * @param {...any} children strings, nodes, arrays or falsy values
 * @returns {HTMLElement}
 */
export function el(tag, attrs, ...children) {
  const node = document.createElement(tag);
  for (const [key, val] of Object.entries(attrs ?? {})) {
    if (val === false || val == null) continue;
    if (key === 'class') node.className = val;
    else if (key === 'style') node.style.cssText = val;
    else if (key === 'dataset') Object.assign(node.dataset, val);
    else if (key === 'on') for (const [ev, fn] of Object.entries(val)) node.addEventListener(ev, fn);
    else if (key === 'value' || key === 'checked' || key === 'disabled' || key === 'selected' || key === 'indeterminate') node[key] = val;
    else node.setAttribute(key, val === true ? '' : val);
  }
  append(node, children);
  return node;
}

export function append(node, children) {
  for (const child of children.flat(Infinity)) {
    if (child === false || child == null) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

export function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
  return node;
}

export const clone = (v) => JSON.parse(JSON.stringify(v ?? null));

export function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${stable(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export const sameValue = (a, b) => stable(a) === stable(b);

export function uid(prefix = 'x') {
  return `${prefix}.${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

export function debounce(fn, ms) {
  let timer = null;
  const wrapped = (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => { timer = null; fn(...args); }, ms);
  };
  wrapped.flush = (...args) => { clearTimeout(timer); timer = null; fn(...args); };
  wrapped.cancel = () => { clearTimeout(timer); timer = null; };
  return wrapped;
}

const NUMBER = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2 });

/** @param {number} n @param {number} [digits] */
export function fmt(n, digits = 2) {
  if (!Number.isFinite(n)) return '—';
  return digits === 2 ? NUMBER.format(n) : n.toLocaleString('ru-RU', { maximumFractionDigits: digits });
}

export const pct = (ratio, digits = 0) => (Number.isFinite(ratio) ? `${fmt(ratio * 100, digits)}%` : '—');

/** Parse a number field; empty or invalid input gives `fallback`. */
export function parseNum(text, fallback = 0) {
  const n = Number(String(text).replace(',', '.'));
  return Number.isFinite(n) && String(text).trim() !== '' ? n : fallback;
}

/**
 * Wire `textarea` to grow with its content. It measures only while it has a real width, so a textarea
 * built off-screen (width 0) does not end up as tall as its wrapped placeholder.
 */
export function autoGrow(textarea) {
  const grow = () => {
    if (!textarea.isConnected || !textarea.offsetWidth) return;
    textarea.style.height = 'auto';
    textarea.style.height = `${Math.min(textarea.scrollHeight, 320)}px`;
  };
  textarea.addEventListener('input', grow);
  let lastWidth = -1;
  new ResizeObserver(([entry]) => {
    const width = Math.round(entry.contentRect.width);
    if (width !== lastWidth) { lastWidth = width; grow(); }
  }).observe(textarea);
  return textarea;
}

export function safeStorage() {
  try {
    const key = '__balance_probe__';
    window.localStorage.setItem(key, '1');
    window.localStorage.removeItem(key);
    return window.localStorage;
  } catch {
    return null;
  }
}

export function readStored(key, fallback = null) {
  try {
    const raw = safeStorage()?.getItem(key);
    return raw == null ? fallback : JSON.parse(raw);
  } catch {
    return fallback;
  }
}

export function writeStored(key, value) {
  try { safeStorage()?.setItem(key, JSON.stringify(value)); } catch { /* storage is a convenience only */ }
}
