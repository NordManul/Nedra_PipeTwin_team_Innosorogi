/**
 * Карточка события (WP-B10, WP-C4): тип и уверенность, место ± ошибка, расход утечки,
 * потери к тревоге и прогноз при бездействии, вклад датчиков, рекомендация, «принять».
 */
import type { EventCard } from '@pipetwin/core/contracts';
import { clear, download, h } from './dom';
import { fmt } from './format';
import { STAGE_NAMES } from './operator';

const CLASS_NAMES: Record<string, string> = {
  leak: 'Утечка',
  'pump-change': 'Смена режима насоса',
  'valve-change': 'Смена положения задвижки',
  'sensor-fault': 'Отказ датчика',
  unknown: 'Отклонение неясной природы',
};

export class CardPanel {
  private cards: EventCard[] = [];
  private acknowledged = new Set<string>();

  constructor(private readonly host: HTMLElement, private readonly onAck: (card: EventCard) => void) {
    this.render();
  }

  upsert(card: EventCard): void {
    const i = this.cards.findIndex((c) => c.id === card.id);
    if (i >= 0) this.cards[i] = card;
    else this.cards.unshift(card);
    this.render();
  }

  reset(): void {
    this.cards = [];
    this.acknowledged.clear();
    this.render();
  }

  get all(): EventCard[] {
    return this.cards;
  }

  private render(): void {
    clear(this.host);
    const head = h(
      'div',
      { class: 'panel-head' },
      h('h3', {}, 'Карточка события'),
      this.cards.length ? h('button', { class: 'small', onclick: () => download('pipetwin-events.json', JSON.stringify(this.cards, null, 2)) }, 'Экспорт JSON') : '',
    );
    this.host.append(head);
    const cur = this.cards[0];
    if (!cur) {
      this.host.append(h('p', { class: 'muted' }, 'Событий нет.'));
      return;
    }
    this.host.append(this.renderCard(cur, true));
    if (this.cards.length > 1) {
      const hist = h('details', { class: 'history' }, h('summary', {}, `История за сессию: ${this.cards.length - 1}`));
      for (const c of this.cards.slice(1)) hist.append(this.renderCard(c, false));
      this.host.append(hist);
    }
  }

  private renderCard(c: EventCard, big: boolean): HTMLElement {
    const ack = this.acknowledged.has(c.id) || c.acknowledgedAt !== undefined;
    const iv = c.location?.interval;
    const loc = c.location
      ? iv
        ? `км ${fmt(iv[0] / 1000, 1)}–${fmt(iv[1] / 1000, 1)} (оценка км ${fmt(c.location.x / 1000, 1)})`
        : `км ${fmt(c.location.x / 1000, 1)}`
      : 'уточняется (ждём прихода волн)';
    const stage = c.location?.stage ? STAGE_NAMES[c.location.stage] : '';
    const isLeak = c.eventClass === 'leak' || c.eventClass === 'unknown';
    const rows: Array<[string, string]> = isLeak
      ? [
      ['Зона поиска (≈90%)', loc],
      ['Как определена', stage || '—'],
      ['Расход утечки', c.leakRate !== undefined ? `${fmt(c.leakRate * 3600, 1)} м³/ч${c.leakFraction !== undefined ? ` (${fmt(c.leakFraction * 100, 1)}% расхода)` : ''}` : '—'],
      ['Потери к тревоге', c.vLoss !== undefined ? `${fmt(c.vLoss, 2)} м³` : '—'],
      ['Прогноз за 30 мин бездействия', c.vLossForecast30min !== undefined ? `${fmt(c.vLossForecast30min, 1)} м³` : '—'],
      ['Детектор', c.detector],
        ]
      : [
          ...(c.eventClass === 'sensor-fault' ? ([['Датчик', c.contributions[0]?.sensorId ?? '—']] as Array<[string, string]>) : []),
          ['Детектор', c.detector],
        ];
    const contrib = h('div', { class: 'contrib' });
    for (const x of c.contributions.slice(0, 6)) {
      contrib.append(h('div', { class: 'bar-row' }, h('span', {}, x.sensorId), h('div', { class: 'bar' }, h('div', { style: `width:${(x.share * 100).toFixed(0)}%` })), h('span', { class: 'muted' }, `${fmt(x.share * 100, 0)}%`)));
    }
    return h(
      'div',
      { class: `card sev-${c.action.severity}${big ? '' : ' small-card'}` },
      h('div', { class: 'card-title' }, h('strong', {}, CLASS_NAMES[c.eventClass] ?? c.eventClass), h('span', { class: 'muted' }, ` · t = ${fmt(c.tAlarm, 1)} с · уверенность ${fmt(c.confidence * 100, 0)}%`)),
      h('table', { class: 'kv' }, ...rows.map(([k, v]) => h('tr', {}, h('td', {}, k), h('td', {}, v)))),
      isLeak && c.contributions.length ? h('div', { class: 'muted small' }, 'Какие датчики дали сигнал') : '',
      isLeak ? contrib : '',
      h('div', { class: 'action' }, c.action.text),
      big
        ? h(
            'button',
            {
              class: ack ? 'small' : 'small primary',
              disabled: ack,
              onclick: () => {
                this.acknowledged.add(c.id);
                this.onAck(c);
                this.render();
              },
            },
            ack ? 'Принято' : 'Принять',
          )
        : '',
    );
  }
}
