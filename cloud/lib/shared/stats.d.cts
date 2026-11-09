// Types for the extension's stats.js (copied here as stats.cjs by scripts/sync-shared.mjs).
type Verdict = 'too-few' | 'notable' | 'noise';
declare const AviatorStats: {
  RTP: number;
  MIN_CASES: number;
  NOTABLE_Z: number;
  baseRate(values: number[], target: number): {n: number; hits: number; rate: number; ci: [number, number]; expected: number; breakEven: number; returnPer100: number};
  oddsMatch(values: number[], target: number): {n: number; hits: number; z: number; verdict: 'too-few' | 'differs' | 'matches'};
  trendChecks(values: number[], target: number, gaps?: number[]): {label: string; n: number; hits: number; rate: number; restRate: number; z: number; verdict: Verdict; ci: [number, number]}[];
  runsTest(values: number[], target: number, gaps?: number[]): {n: number; runs: number; expected: number; z: number; verdict: Verdict};
  serialCorrelation(values: number[], gaps?: number[]): {n: number; r: number; z: number; verdict: Verdict};
  quality(values: number[], gaps?: number[]): {rounds: number; breaks: number; longest: number};
  segments(values: number[], gaps?: number[]): number[][];
  simulatePlan(plan: {bet: number; target: number; rounds: number; budget: number}, sessions?: number, random?: () => number): {expectedLoss: number; totalWagered: number; bustChance: number; profitChance: number; medianEnd: number; worst10: number};
  reviewLog(log: {bet: number; won: number}[], limit: number): {net: number; wagered: number; rounds: number; chases: number; warnings: string[]};
};
export = AviatorStats;
