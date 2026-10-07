import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

/*
 * Self-tests of the stage 5 query figures in the quality budgets (wave 2a1): freshness options
 * without a marker, whole-cache invalidations and timers. The script is a gate: each rule is proven
 * red without its budget entry and green with it, so a later edit that quietly widens a rule shows
 * up here first.
 */
const SCRIPT = path.resolve(process.cwd(), 'scripts/quality.mjs');
const FIXTURE = 'src/features/example/fixture.ts';

type Budget = Record<string, unknown>;

/** A budget that knows every figure at zero: anything the fixture holds is growth. */
const EMPTY_BUDGET: Budget = {
  legacyFiles: { hooks: 0, utils: 0, components: 0 },
  rawKeyFiles: 0,
  antdDeprecated: 0,
  maxLines: {},
  queryFreshnessUnmarked: 0,
  unfilteredInvalidations: [],
  timers: [],
};

function run(files: Record<string, string>, budget?: Budget, mode: 'check' | 'update' = 'check') {
  const root = mkdtempSync(path.join(tmpdir(), 'quality-check-'));
  for (const [rel, code] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    writeFileSync(path.join(root, rel), code);
  }
  const budgetFile = path.join(root, 'quality-budget.json');
  if (budget) writeFileSync(budgetFile, JSON.stringify(budget));
  const result = spawnSync(process.execPath, [SCRIPT, mode], { cwd: root, encoding: 'utf8' });
  const written = existsSync(budgetFile)
    ? (JSON.parse(readFileSync(budgetFile, 'utf8')) as Budget)
    : undefined;
  rmSync(root, { recursive: true, force: true });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr, budget: written };
}

/** The figures as the script measures them: `update` without a budget records them as they are. */
function measure(files: Record<string, string>): Budget {
  const { status, budget } = run(files, undefined, 'update');
  expect(status).toBe(0);
  return budget!;
}

const CONFIG = `
export const QUERY_PROFILE = {
  LIVE: { staleTime: 10_000, gcTime: 300_000, refetchOnWindowFocus: false },
  PICK: { staleTime: 60_000 },
} as const;
`;

describe('quality budgets: freshness options without a marker', () => {
  it('counts each option written outside the config module, not comments, strings or types', () => {
    const figures = measure({
      'src/shared/config/query.ts': CONFIG,
      [FIXTURE]: `
declare function useQuery(options: unknown): unknown;
declare const staleTime: number;
interface Options { staleTime: number; gcTime: number }
// staleTime: 0 in a comment is not an option
export const text = 'refetchOnWindowFocus: true';
export function useRoute() {
  useQuery({
    staleTime: 0,
    gcTime: 0,
    refetchOnMount: 'always',
    refetchOnWindowFocus: true,
    refetchOnReconnect: false,
    refetchInterval: 1000,
  });
  return useQuery({ staleTime });
}
export type { Options };
`,
    });
    // Seven written options; the four of the config module stay out.
    expect(figures.queryFreshnessUnmarked).toBe(7);
  });

  it('fails on a new unmarked option and names its place', () => {
    const { status, stderr } = run(
      {
        [FIXTURE]: `
declare function useQuery(options: unknown): unknown;
export const useOne = () => useQuery({ staleTime: 0 });
`,
      },
      EMPTY_BUDGET,
    );
    expect(status).toBe(1);
    expect(stderr).toContain('опций свежести без маркера: 1, бюджет 0');
    expect(stderr).toContain(`${FIXTURE}:3 staleTime`);
  });

  it('takes a marker inside the braces of the options object or right above its statement', () => {
    const { status, stderr } = run(
      {
        'src/shared/config/query.ts': CONFIG,
        [FIXTURE]: `
declare function useQuery(options: unknown): unknown;
declare function queryOptions<T>(options: T): T;
export function useInside() {
  return useQuery({
    // query-freshness: exception — the route version is checked by the server on every action
    staleTime: 0,
    refetchOnMount: 'always',
  });
}
export function useAtLineEnd() {
  return useQuery({
    enabled: true,
    gcTime: 0, // query-freshness: exception — one-shot answer, dropped when the form closes
  });
}
export function useAbove() {
  // query-freshness: PICK — an open form rereads a list older than a minute
  const read = useQuery({ staleTime: 60_000 });
  return read;
}
/**
 * The factory's own documentation is the statement's leading comment.
 * query-freshness: exception — a report for past days, not the state of now
 */
export const reportQuery = () => queryOptions({ staleTime: 60_000 });
`,
      },
      EMPTY_BUDGET,
    );
    expect(stderr).toBe('');
    expect(status).toBe(0);
  });

  it('does not let a marker reach a neighbouring read or a read further down', () => {
    const figures = measure({
      [FIXTURE]: `
declare function useQuery(options: unknown): unknown;
export function useNeighbours() {
  const a = useQuery({ staleTime: 0 }); // query-freshness: exception — written after a, not above b
  const b = useQuery({ staleTime: 0 });
  return [a, b];
}
export function useTwo() {
  // query-freshness: exception — covers the next statement only
  const a = useQuery({ staleTime: 0 });
  const b = useQuery({ staleTime: 0 });
  return [a, b];
}
// query-freshness: exception — above the function, not above the read
export function useFar() {
  return useQuery({ staleTime: 0 });
}
`,
    });
    // useNeighbours: both unmarked; useTwo: b unmarked; useFar: unmarked.
    expect(figures.queryFreshnessUnmarked).toBe(4);
  });

  it('does not take the marker words from a string or from JSX text', () => {
    const figures = measure({
      'src/features/example/Card.tsx': `
declare function useQuery(options: unknown): unknown;
export function useCard() {
  return useQuery({
    note: 'query-freshness: exception — a string, not a comment',
    staleTime: 0,
    render: <p>query-freshness: exception — JSX text, not a comment</p>,
  });
}
`,
    });
    expect(figures.queryFreshnessUnmarked).toBe(1);
  });

  it('does not take a malformed marker and says what is wrong with it', () => {
    const files = {
      'src/shared/config/query.ts': CONFIG,
      [FIXTURE]: `
declare function useQuery(options: unknown): unknown;
export const typo = () => useQuery({
  // query-freshness: exeption — misspelt word
  staleTime: 0,
});
export const russian = () => useQuery({
  // query-freshness: exception — причина по-русски
  staleTime: 0,
});
export const bare = () => useQuery({
  // query-freshness: exception
  staleTime: 0,
});
export const unknownProfile = () => useQuery({
  // query-freshness: DICTIONARY — the config module has no such profile yet
  staleTime: 0,
});
`,
    };
    expect(measure(files).queryFreshnessUnmarked).toBe(4);
    const { status, stderr } = run(files, EMPTY_BUDGET);
    expect(status).toBe(1);
    expect(stderr).toContain('«exeption» — не профиль');
    expect(stderr).toContain('причина пишется по-английски');
    expect(stderr).toContain('ожидается «query-freshness:');
    expect(stderr).toContain('«DICTIONARY» — не профиль');
  });

  it('fails on an improvement that is not written down, and update writes it', () => {
    const files = {
      [FIXTURE]: `
declare function useQuery(options: unknown): unknown;
export const useOne = () => useQuery({ staleTime: 0 });
`,
    };
    const loose = { ...EMPTY_BUDGET, queryFreshnessUnmarked: 2 };
    const checked = run(files, loose);
    expect(checked.status).toBe(1);
    expect(checked.stderr).toContain('опции свежести без маркера: 2 → 1');
    const updated = run(files, loose, 'update');
    expect(updated.status).toBe(0);
    expect(updated.budget?.queryFreshnessUnmarked).toBe(1);
  });
});

const INVALIDATIONS = `
declare const qc: { invalidateQueries(filters?: unknown): Promise<void> };
declare const itemKeys: { all: readonly string[] };
declare const filters: { queryKey: readonly string[] };
export function Page() {
  const refreshOnSwitch = () => void qc.invalidateQueries();
  const onImported = () => {
    void qc.invalidateQueries({});
    void qc.invalidateQueries({ refetchType: 'all' });
  };
  void qc.invalidateQueries({ queryKey: itemKeys.all });
  void qc.invalidateQueries({ predicate: () => true });
  void qc.invalidateQueries(filters);
  void qc.invalidateQueries({ ...filters });
  // qc.invalidateQueries() in a comment is not a call
  const text = 'qc.invalidateQueries()';
  return { refreshOnSwitch, onImported, text };
}
`;
const INVALIDATION_LIST = [
  `${FIXTURE} › Page › onImported`,
  `${FIXTURE} › Page › onImported #2`,
  `${FIXTURE} › Page › refreshOnSwitch`,
];

describe('quality budgets: invalidateQueries without a filter', () => {
  it('lists calls with no queryKey and no predicate by their enclosing functions', () => {
    expect(measure({ [FIXTURE]: INVALIDATIONS }).unfilteredInvalidations).toEqual(
      INVALIDATION_LIST,
    );
  });

  it('is red without the list and green with it', () => {
    const red = run({ [FIXTURE]: INVALIDATIONS }, EMPTY_BUDGET);
    expect(red.status).toBe(1);
    expect(red.stderr).toContain('новые места вне перечня');
    expect(red.stderr).toContain(`${FIXTURE} › Page › refreshOnSwitch (строка 6)`);

    const listed = { ...EMPTY_BUDGET, unfilteredInvalidations: INVALIDATION_LIST };
    expect(run({ [FIXTURE]: INVALIDATIONS }, listed).status).toBe(0);
  });

  it('keeps a place when lines above it move', () => {
    const listed = { ...EMPTY_BUDGET, unfilteredInvalidations: INVALIDATION_LIST };
    const moved = `// a new comment\n\n\n${INVALIDATIONS}`;
    expect(run({ [FIXTURE]: moved }, listed).status).toBe(0);
  });

  it('is red on a dead entry until update drops it', () => {
    const dead = `${FIXTURE} › Page › removedHandler`;
    const listed = { ...EMPTY_BUDGET, unfilteredInvalidations: [...INVALIDATION_LIST, dead] };
    const checked = run({ [FIXTURE]: INVALIDATIONS }, listed);
    expect(checked.status).toBe(1);
    expect(checked.stderr).toContain(`места ${dead} в коде нет — запись мёртвая`);

    const updated = run({ [FIXTURE]: INVALIDATIONS }, listed, 'update');
    expect(updated.status).toBe(0);
    expect(updated.budget?.unfilteredInvalidations).toEqual(INVALIDATION_LIST);
  });

  it('does not let update add a place to the list', () => {
    const { status, budget } = run({ [FIXTURE]: INVALIDATIONS }, EMPTY_BUDGET, 'update');
    expect(status).toBe(1);
    expect(budget?.unfilteredInvalidations).toEqual([]);
  });
});

const TIMERS = `
declare function useEffect(effect: () => void | (() => void), deps: unknown[]): void;
declare function poll(): Promise<{ done: boolean }>;
declare function runSearch(text: string): void;
export function useFeed() {
  useEffect(() => {
    const timer = setInterval(() => undefined, 20_000);
    return () => clearInterval(timer);
  }, []);
}
export const healthQuery = () => ({ refetchInterval: 60_000 });
export const quietQuery = () => ({ refetchInterval: false });
export function useBulk() {
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const ask = async () => {
      const status = await poll();
      if (!status.done) timer = setTimeout(() => void ask(), 1000);
    };
    timer = setTimeout(() => void ask(), 0);
    return () => clearTimeout(timer);
  }, []);
}
export function tick() {
  setTimeout(tick, 500);
}
export function ping() {
  window.setTimeout(() => pong(), 500);
}
function pong() {
  ping();
}
export function useSearch(onChange: (text: string) => void) {
  let pending: ReturnType<typeof setTimeout> | undefined;
  const search = (text: string) => {
    clearTimeout(pending);
    pending = setTimeout(() => runSearch(text), 300);
  };
  const handlers = { onChange: (text: string) => setTimeout(() => onChange(text), 300) };
  const scroll = () => window.setTimeout(() => window.scrollTo(0, 0), 300);
  // setInterval(() => undefined, 1) in a comment is not a call
  return { search, handlers, scroll };
}
`;
const TIMER_LIST = [
  `${FIXTURE} › healthQuery › refetchInterval`,
  `${FIXTURE} › ping › setTimeout`,
  `${FIXTURE} › tick › setTimeout`,
  `${FIXTURE} › useBulk › ask › setTimeout`,
  `${FIXTURE} › useFeed › setInterval`,
];

describe('quality budgets: timers', () => {
  it('lists intervals, polling queries and self-restarting timeouts, not single delays', () => {
    // The kick-off of the bulk poll, the debounce, a handler calling a prop named like itself and
    // the delayed scroll are single delays; `refetchInterval: false` switches polling off.
    expect(measure({ [FIXTURE]: TIMERS }).timers).toEqual(TIMER_LIST);
  });

  it('is red on a timer outside the list and green with it', () => {
    const listed = { ...EMPTY_BUDGET, queryFreshnessUnmarked: 2, timers: TIMER_LIST };
    expect(run({ [FIXTURE]: TIMERS }, listed).status).toBe(0);

    const red = run({ [FIXTURE]: TIMERS }, { ...listed, timers: TIMER_LIST.slice(1) });
    expect(red.status).toBe(1);
    expect(red.stderr).toContain('таймеры — новые места вне перечня');
    expect(red.stderr).toContain(`${FIXTURE} › healthQuery › refetchInterval (строка 11)`);
  });
});
