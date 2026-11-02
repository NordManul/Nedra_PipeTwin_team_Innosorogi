/**
 * D7: слияние нескольких детекторов (WP-B2): голосование или взвешенная сумма
 * нормированных статистик score/threshold. Место и расход — от самого уверенного участника.
 */
import type { DetectorParams } from '@pipetwin/core/contracts';
import type { PreparedSample, Statistic, StatOut } from '../types';

export interface FusionMember {
  name: string;
  stat: Statistic;
  weight: number;
}

export class FusionStat implements Statistic {
  constructor(private readonly members: FusionMember[], private readonly p: DetectorParams, private readonly rule: 'vote' | 'weighted-sum') {}

  update(s: PreparedSample): StatOut {
    const outs = this.members.map((m) => ({ m, o: m.stat.update(s) }));
    const ratio = (o: StatOut) => (o.threshold > 0 ? o.score / o.threshold : 0);
    const votes = outs.filter(({ o }) => o.alarm ?? ratio(o) > 1).length;
    const wsum = outs.reduce((acc, { m }) => acc + m.weight, 0) || 1;
    const weighted = outs.reduce((acc, { m, o }) => acc + m.weight * (o.alarm ? Math.max(1.01, ratio(o)) : ratio(o)), 0) / wsum;
    const lead = outs.reduce((best, cur) => (ratio(cur.o) > ratio(best.o) ? cur : best), outs[0]!);
    const located = outs.find(({ o }) => o.location !== undefined && (o.alarm ?? ratio(o) > 1)) ?? lead;
    const rated = outs.find(({ o }) => o.leakRate !== undefined && (o.alarm ?? ratio(o) > 1));
    const onsets = outs.map(({ o }) => o.onset).filter((v): v is number => v !== undefined);
    const base: StatOut =
      this.rule === 'vote'
        ? { score: votes, threshold: this.p.minVotes!, alarm: votes >= this.p.minVotes! }
        : { score: weighted, threshold: this.p.thr! };
    return {
      ...base,
      channels: lead.o.channels,
      location: located.o.location,
      locationInterval: located.o.locationInterval,
      leakRate: rated?.o.leakRate ?? lead.o.leakRate,
      onset: onsets.length ? Math.min(...onsets) : undefined,
    };
  }

  rearm(): void {
    for (const m of this.members) m.stat.rearm();
  }
}
