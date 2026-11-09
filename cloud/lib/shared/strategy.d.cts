// Types for strategy.cjs
export type BetChange =
  | {kind: 'same'}
  | {kind: 'reset'}
  | {kind: 'multiply'; factor: number}
  | {kind: 'add'; amount: number};

export type TriggerRule =
  | {kind: 'every'}
  | {kind: 'afterLows'; count: number; below: number}
  | {kind: 'afterHigh'; above: number};

export type StrategyConfig = {
  bet: number;
  target: number;
  budget: number;
  rounds: number;
  trigger: TriggerRule;
  onLoss: BetChange;
  onWin: BetChange;
  winReset: number;
  maxBet: number;
  stopLoss: number;
  takeProfit: number;
};

export type SessionResult = {
  end: 'rounds' | 'bust' | 'stopLoss' | 'takeProfit' | 'data';
  played: number;
  bets: number;
  wins: number;
  wagered: number;
  net: number;
  maxDrawdown: number;
  biggestBet: number;
  longestLossRun: number;
  history: number[];
};

export type StrategySummary = {
  sessions: number;
  bets: number;
  wins: number;
  wagered: number;
  net: number;
  hitRate: number;
  returnPer100: number;
  avgNet: number;
  aheadChance: number;
  bustChance: number;
  stopLossChance: number;
  takeProfitChance: number;
  medianNet: number;
  worst10: number;
  worst: number;
  best: number;
  maxDrawdown: number;
  biggestBet: number;
  longestLossRun: number;
  budget: number;
};

export type ParsedStrategy = {
  strategy: StrategyConfig;
  understood: string[];
  ignored: string[];
  errors: string[];
};

declare const AviatorStrategy: {
  parse(text: string): ParsedStrategy;
  describe(st: StrategyConfig): string[];
  validate(st: StrategyConfig): string[];
  playSession(st: StrategyConfig, next: () => number | undefined, history?: number[]): SessionResult;
  backtest(st: StrategyConfig, values: number[], gaps?: number[]): StrategySummary;
  simulate(st: StrategyConfig, sessions?: number, random?: () => number): StrategySummary;
  verdict(sim: StrategySummary): string[];
  crash(random: () => number): number;
  DEFAULTS: Readonly<StrategyConfig>;
  RTP: number;
};

export = AviatorStrategy;

