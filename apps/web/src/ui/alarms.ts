/**
 * Журнал сигналов СОУ: приоритет, время, источник, сообщение, состояние, квитирование.
 * Как в диспетчерских системах: активная неквитированная авария мигает, оператор квитирует,
 * после снятия причины сигнал остаётся в журнале со статусом «снят».
 */
import { clear, download, h } from './dom';
import { fmt } from './format';

export type Priority = 'alarm' | 'warning' | 'info';

export interface AlarmEntry {
  id: string;
  priority: Priority;
  /** Модельное время появления, с. */
  t: number;
  /** Время на часах оператора. */
  wall: string;
  source: string;
  text: string;
  active: boolean;
  ackWall?: string;
  clearedT?: number;
}

const PRIORITY_NAME: Record<Priority, string> = { alarm: 'АВАРИЯ', warning: 'ПРЕДУПР.', info: 'ИНФО' };

export class AlarmLog {
  private items: AlarmEntry[] = [];
  private seq = 0;
  private key: string | null = null;
  /** Последнее снятие аварии — показываем в строке аварии зелёным, пока нет новых сигналов. */
  private lastCleared: { wall: string; text: string; at: number } | null = null;

  constructor(
    private readonly host: HTMLElement,
    private readonly banner: HTMLElement,
    private readonly onAck: (e: AlarmEntry) => void,
  ) {
    this.render();
  }

  reset(): void {
    this.items = [];
    this.lastCleared = null;
    this.render();
  }

  /** Новый сигнал; возвращает его id (по нему потом обновляют текст и снимают). */
  raise(priority: Priority, t: number, source: string, text: string): string {
    const id = `A${++this.seq}`;
    this.items.unshift({ id, priority, t, wall: new Date().toLocaleTimeString('ru-RU'), source, text, active: true });
    this.items.length = Math.min(this.items.length, 200);
    this.render();
    return id;
  }

  /** Сообщение без активного состояния (информация о событии). */
  note(t: number, source: string, text: string): void {
    const id = this.raise('info', t, source, text);
    const e = this.items.find((x) => x.id === id)!;
    e.active = false;
    e.ackWall = e.wall;
    this.render();
  }

  update(id: string, text: string): void {
    const e = this.items.find((x) => x.id === id);
    if (e && e.text !== text) {
      e.text = text;
      this.render();
    }
  }

  /**
   * Снять сигнал: причина ушла (система сама увидела, что показания вернулись к норме).
   * Снятый сигнал квитируется автоматически — мигание и красная строка пропадают, запись остаётся в журнале.
   */
  clearAlarm(id: string, t: number, text?: string): void {
    const e = this.items.find((x) => x.id === id);
    if (e && e.active) {
      e.active = false;
      e.clearedT = t;
      if (text) e.text = text;
      if (!e.ackWall) e.ackWall = `${new Date().toLocaleTimeString('ru-RU')} (авто)`;
      this.lastCleared = { wall: new Date().toLocaleTimeString('ru-RU'), text: `${e.source}: ${e.text}`, at: performance.now() };
      this.render();
    }
  }

  /** Активных аварий (приоритет «авария»). */
  get activeAlarms(): number {
    return this.items.filter((e) => e.active && e.priority === 'alarm').length;
  }

  ack(id: string): void {
    const e = this.items.find((x) => x.id === id);
    if (e && !e.ackWall) {
      e.ackWall = new Date().toLocaleTimeString('ru-RU');
      this.onAck(e);
      this.render();
    }
  }

  ackAll(): void {
    for (const e of this.items) if (!e.ackWall) this.ack(e.id);
  }

  get unacknowledged(): AlarmEntry[] {
    return this.items.filter((e) => !e.ackWall);
  }

  get all(): AlarmEntry[] {
    return this.items;
  }

  private state(e: AlarmEntry): string {
    if (e.active) return e.ackWall ? 'активен, квитирован' : 'активен';
    return e.ackWall ? (e.clearedT !== undefined ? 'снят' : '—') : 'снят, не квитирован';
  }

  render(): void {
    const key = this.items.map((e) => `${e.id}${e.text}${e.active}${e.ackWall ?? ''}`).join('|');
    if (key === this.key) return;
    this.key = key;
    this.renderBanner();
    clear(this.host);
    const unack = this.unacknowledged.length;
    this.host.append(
      h(
        'div',
        { class: 'panel-head' },
        h('h3', {}, 'Журнал сигналов'),
        h(
          'div',
          { class: 'row' },
          h('span', { class: 'small muted' }, `неквитировано: ${unack}`),
          h('button', { class: 'small', disabled: !unack, onclick: () => this.ackAll() }, 'Квитировать все'),
          h('button', { class: 'small', disabled: !this.items.length, onclick: () => this.export() }, 'CSV'),
        ),
      ),
    );
    if (!this.items.length) {
      this.host.append(h('p', { class: 'small muted' }, 'Сигналов нет.'));
      return;
    }
    const rows = this.items.slice(0, 60).map((e) =>
      h(
        'tr',
        { class: `pr-${e.priority}${e.active ? ' active' : ''}${e.ackWall ? '' : ' unack'}` },
        h('td', { class: 'pri' }, PRIORITY_NAME[e.priority]),
        h('td', { class: 'mono', title: `модельное время ${fmt(e.t, 1)} с` }, e.wall),
        h('td', {}, h('b', {}, e.source), ' · ', e.text),
        h('td', { class: 'small' }, this.state(e)),
        h('td', {}, e.ackWall ? h('span', { class: 'small muted mono' }, e.ackWall) : h('button', { class: 'small', onclick: () => this.ack(e.id) }, 'Квит.')),
      ),
    );
    this.host.append(
      h(
        'div',
        { class: 'alarm-scroll' },
        h(
          'table',
          { class: 'alarms' },
          h('tr', {}, h('th', {}, 'Приор.'), h('th', {}, 'Время'), h('th', {}, 'Сообщение'), h('th', {}, 'Состояние'), h('th', {}, 'Квит.')),
          ...rows,
        ),
      ),
    );
  }

  /** Строка над схемой: самый важный неквитированный сигнал. */
  private renderBanner(): void {
    const b = this.banner;
    clear(b);
    const order: Priority[] = ['alarm', 'warning', 'info'];
    const top = [...this.unacknowledged].sort((a, c) => order.indexOf(a.priority) - order.indexOf(c.priority) || c.t - a.t)[0];
    const activeAlarm = this.items.find((e) => e.active && e.priority === 'alarm');
    const shown = top ?? activeAlarm;
    b.className = `banner ${shown ? `pr-${shown.priority}${shown.ackWall ? '' : ' unack'}` : this.lastCleared ? 'pr-ok' : 'none'}`;
    if (!shown) {
      if (this.lastCleared) {
        b.append(h('span', { class: 'pri' }, 'НОРМА'), h('span', { class: 'mono' }, this.lastCleared.wall), h('span', { class: 'msg' }, `Авария снята: ${this.lastCleared.text}`));
      } else b.append(h('span', { class: 'small' }, 'Активных аварийных сигналов нет'));
      return;
    }
    b.append(
      h('span', { class: 'pri' }, PRIORITY_NAME[shown.priority]),
      h('span', { class: 'mono' }, shown.wall),
      h('span', { class: 'msg' }, `${shown.source}: ${shown.text}`),
      shown.ackWall ? h('span', { class: 'small' }, `квитирован ${shown.ackWall}`) : h('button', { class: 'small', onclick: () => this.ack(shown.id) }, 'Квитировать'),
    );
  }

  private export(): void {
    const lines = ['приоритет;время;t модели, с;источник;сообщение;состояние;квитирован'];
    for (const e of [...this.items].reverse()) lines.push([PRIORITY_NAME[e.priority], e.wall, fmt(e.t, 1), e.source, e.text, this.state(e), e.ackWall ?? ''].join(';'));
    download('pipetwin-alarms.csv', lines.join('\n') + '\n', 'text/csv');
  }
}
