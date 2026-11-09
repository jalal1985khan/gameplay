// Live drift monitor: a two-sided Bernoulli CUSUM on "the round reached the target".
// Under a fair game the hit chance is RTP / target, round after round. The CUSUM adds up
// evidence that the captured hit rate has moved away from that (by `shift`, 20% by default)
// and raises an alarm once the evidence passes `threshold`. With the defaults a fair stream
// raises a false alarm about once per 2,000 rounds at 1.5×, 5,000 at 2× and far less often at
// higher targets (measured on simulated fair rounds).
// An alarm almost always means the capture is wrong (missed, doubled or misread rounds),
// not that the game became beatable: check capture health first.
export type DriftAlarm = {index: number; direction: 'high' | 'low'};
export type Drift = {
  expected: number;
  upper: number;
  lower: number;
  threshold: number;
  alarms: DriftAlarm[];
  status: 'too-few' | 'ok' | 'alarm';
  recentRate: number | null;
  recentN: number;
};

export function drift(values: number[], gaps: number[], target: number,
  {rtp = 0.97, shift = 0.2, threshold = 5, window = 200, minRounds = 50, alarmMemory = 200} = {}): Drift {
  const p0 = Math.min(0.999, rtp / target);
  const hi = Math.min(0.999, p0 * (1 + shift)), lo = p0 * (1 - shift);
  const step = (p1: number, hit: boolean) => hit ? Math.log(p1 / p0) : Math.log((1 - p1) / (1 - p0));
  const breaks = new Set(gaps);
  let upper = 0, lower = 0;
  const alarms: DriftAlarm[] = [];
  values.forEach((v, i) => {
    if (breaks.has(i)) { upper = 0; lower = 0; } // Evidence never carries across missed rounds.
    const hit = v >= target;
    upper = Math.max(0, upper + step(hi, hit));
    lower = Math.max(0, lower + step(lo, hit));
    if (upper >= threshold) { alarms.push({index: i, direction: 'high'}); upper = 0; }
    if (lower >= threshold) { alarms.push({index: i, direction: 'low'}); lower = 0; }
  });
  const recent = values.slice(-window);
  const last = alarms.at(-1);
  return {
    expected: p0, upper, lower, threshold, alarms,
    status: values.length < minRounds ? 'too-few' : last && values.length - 1 - last.index < alarmMemory ? 'alarm' : 'ok',
    recentRate: recent.length ? recent.filter(v => v >= target).length / recent.length : null,
    recentN: recent.length,
  };
}
