/** Минимальный помощник для построения DOM без фреймворка. */
type Attrs = Record<string, string | number | boolean | EventListener | undefined>;
type Child = Node | string | number | null | undefined | false;

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Attrs = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v as EventListener);
    else if (k === 'class') el.className = String(v);
    else if (k === 'html') el.innerHTML = String(v);
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, String(v));
  }
  for (const c of children) if (c !== null && c !== undefined && c !== false) el.append(c instanceof Node ? c : String(c));
  return el;
}

export function clear(el: Element): void {
  while (el.firstChild) el.removeChild(el.firstChild);
}

export function $(sel: string, root: ParentNode = document): HTMLElement {
  const el = root.querySelector(sel);
  if (!el) throw new Error(`нет элемента ${sel}`);
  return el as HTMLElement;
}

/** Скачать текст или dataURL как файл. */
export function download(name: string, content: string, type = 'application/json'): void {
  const url = content.startsWith('data:') ? content : URL.createObjectURL(new Blob([content], { type }));
  const a = h('a', { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  if (!content.startsWith('data:')) setTimeout(() => URL.revokeObjectURL(url), 1000);
}
