/**
 * Журнал находок: проверяется не хранение, а МОЛЧАНИЕ.
 *
 * Главный тест этапа — «решённая находка второй раз агенту не показывается»: ради него журнал и
 * написан, и его провал означает, что система снова платит за каждый вопрос, на который человек
 * уже ответил. Остальные тесты стерегут обратную беду — память, которая не истекает: у каждой
 * причины переоткрытия здесь свой тест, потому что молча спрятанная находка не оставляет следа,
 * по которому её можно было бы хватиться.
 *
 * Время в тестах задаётся числом, а не берётся у часов: сроки пересмотра измеряются месяцами, и
 * тест, зависящий от сегодняшней даты, проверял бы календарь.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import {
  JsonFindingStore,
  decide,
  evidenceDigestOf,
  reconcile,
  type LedgerEntry,
  type ReconcileInput,
} from '../state/ledger.ts';
import { trackFinding, type Finding, type TrackedFinding } from '../core/finding.ts';
import type { LedgerPolicy } from '../core/types.ts';

const REPO = path.resolve(import.meta.dirname, '..', '..', '..');

const POLICY: LedgerPolicy = {
  reopenOnCodeChange: true,
  reopenOnPolicyChange: true,
  deferredReviewDays: 90,
  falsePositiveReviewDays: 180,
};

const BASE: Finding = {
  id: 'F1',
  category: 'dead-code',
  title: 'Неиспользуемая обёртка',
  severity: 'medium',
  confidence: 0.9,
  files: ['apps/api/src/x.ts'],
  evidence: 'функция wrap не вызывается ни из одного файла',
  policy: 'P-dead-code',
  behaviorRisk: 'low',
  suggestedAction: 'удалить wrap',
};

const FOUND: TrackedFinding = trackFinding(BASE);

function at(iso: string): Date {
  return new Date(iso);
}

/** Сверка с умолчаниями: код и правило не менялись — так проверяются причины по одной. */
function sync(over: Partial<ReconcileInput> = {}): ReturnType<typeof reconcile> {
  return reconcile({
    entries: [],
    findings: [FOUND],
    policy: POLICY,
    now: at('2026-09-14T10:00:00.000Z'),
    codeChanged: () => false,
    policyChanged: () => false,
    ...over,
  });
}

/** Запись журнала с уже принятым решением. */
function decided(status: LedgerEntry['status'], decidedAt: string): LedgerEntry {
  return {
    fingerprint: FOUND.fingerprint,
    status,
    title: FOUND.title,
    files: [...FOUND.files],
    policy: FOUND.policy,
    firstSeen: '2026-01-01T00:00:00.000Z',
    lastSeen: '2026-01-01T00:00:00.000Z',
    decidedAt,
    note: 'так решили',
    evidenceDigest: evidenceDigestOf(FOUND.evidence),
  };
}

test('находка с неизвестным отпечатком — новая и идёт агенту', () => {
  const result = sync();
  assert.equal(result.fresh.length, 1);
  assert.equal(result.suppressed.length, 0);
  assert.equal(result.entries.length, 1);
  assert.equal(result.entries[0]?.status, 'new');
  assert.equal(result.entries[0]?.firstSeen, '2026-09-14T10:00:00.000Z');
});

test('осознанный долг второй раз агенту не показывается', () => {
  // Ради этого журнал и существует: неизменившаяся находка с принятым решением стоит ноль.
  const result = sync({ entries: [decided('accepted-debt', '2026-02-01T00:00:00.000Z')] });
  assert.equal(result.fresh.length, 0);
  assert.equal(result.reopened.length, 0);
  assert.equal(result.suppressed.length, 1);
  assert.equal(result.suppressed[0]?.entry.status, 'accepted-debt');
  assert.match(result.suppressed[0]?.why ?? '', /осознанный долг/);
});

test('ложное срабатывание тоже молчит, пока не истёк его срок', () => {
  // 180 дней от решения: 100 дней — ещё рано, и находка не показывается.
  const result = sync({
    entries: [decided('false-positive', '2026-06-06T10:00:00.000Z')],
    now: at('2026-09-14T10:00:00.000Z'),
  });
  assert.equal(result.fresh.length, 0);
  assert.equal(result.suppressed.length, 1);
});

test('изменившийся код переоткрывает решение', () => {
  const result = sync({
    entries: [decided('accepted-debt', '2026-02-01T00:00:00.000Z')],
    codeChanged: () => true,
  });
  assert.equal(result.fresh.length, 1);
  assert.equal(result.reopened.length, 1);
  assert.equal(result.entries[0]?.status, 'reopened');
});

test('изменившееся правило переоткрывает решение', () => {
  const result = sync({
    entries: [decided('false-positive', '2026-09-01T00:00:00.000Z')],
    policyChanged: () => true,
  });
  assert.equal(result.fresh.length, 1);
  assert.equal(result.reopened[0]?.status, 'reopened');
});

test('выключённое в политике переоткрытие по коду оставляет решение в силе', () => {
  // Настройка обязана действовать: иначе журнал забывал бы по собственному усмотрению.
  const result = sync({
    entries: [decided('accepted-debt', '2026-02-01T00:00:00.000Z')],
    policy: { ...POLICY, reopenOnCodeChange: false },
    codeChanged: () => true,
  });
  assert.equal(result.fresh.length, 0);
  assert.equal(result.suppressed.length, 1);
});

test('истёкший срок пересмотра переоткрывает отложенную находку', () => {
  // 90 дней у `deferred`: решение от 1 июня к 14 сентября старше срока.
  const result = sync({ entries: [decided('deferred', '2026-06-01T10:00:00.000Z')] });
  assert.equal(result.fresh.length, 1);
  assert.equal(result.reopened.length, 1);
  assert.equal(result.reopened[0]?.status, 'reopened');
});

test('не истёкший срок отложенную находку не показывает', () => {
  const result = sync({ entries: [decided('deferred', '2026-08-20T10:00:00.000Z')] });
  assert.equal(result.fresh.length, 0);
  assert.match(result.suppressed[0]?.why ?? '', /отложено/);
});

test('у осознанного долга срока нет: время его не отменяет', () => {
  // Решение трёхлетней давности: ни один из сроков к нему не применяется, отменяет только событие.
  const result = sync({
    entries: [decided('accepted-debt', '2023-01-01T00:00:00.000Z')],
  });
  assert.equal(result.fresh.length, 0);
  assert.equal(result.suppressed.length, 1);
});

test('существенно изменившееся доказательство переоткрывает решение', () => {
  // Отпечаток гасит числа, поэтому «из 2 мест» и «из 17 мест» — одна находка. Дайджест видит, что
  // масштаб проблемы стал другим, и решение о прежнем масштабе больше не действует.
  const before = trackFinding({ ...BASE, evidence: 'wrap вызывается из 2 мест' });
  const after = trackFinding({ ...BASE, evidence: 'wrap вызывается из 17 мест' });
  assert.equal(before.fingerprint, after.fingerprint);
  const entry: LedgerEntry = {
    ...decided('accepted-debt', '2026-09-01T00:00:00.000Z'),
    fingerprint: before.fingerprint,
    evidenceDigest: evidenceDigestOf(before.evidence),
  };
  const result = sync({ entries: [entry], findings: [after] });
  assert.equal(result.fresh.length, 1);
  assert.equal(result.reopened.length, 1);
  assert.equal(result.reopened[0]?.status, 'reopened');
});

test('исправленная находка, появившаяся снова, — регрессия', () => {
  const result = sync({ entries: [decided('fixed', '2026-09-13T00:00:00.000Z')] });
  assert.equal(result.fresh.length, 1);
  assert.equal(result.reopened[0]?.status, 'reopened');
});

test('прошлое решение сохраняется при переоткрытии: человеку решать заново', () => {
  const result = sync({
    entries: [decided('accepted-debt', '2026-02-01T00:00:00.000Z')],
    codeChanged: () => true,
  });
  assert.equal(result.reopened[0]?.note, 'так решили');
  assert.equal(result.reopened[0]?.decidedAt, '2026-02-01T00:00:00.000Z');
});

test('встреча обновляет lastSeen даже у подавленной находки', () => {
  const result = sync({ entries: [decided('accepted-debt', '2026-02-01T00:00:00.000Z')] });
  assert.equal(result.entries[0]?.lastSeen, '2026-09-14T10:00:00.000Z');
  assert.equal(result.entries[0]?.firstSeen, '2026-01-01T00:00:00.000Z');
});

test('запись, не встретившаяся в прогоне, остаётся и не считается исправленной', () => {
  // Отсутствие находки не доказывает починку: область прогона бывает неполной.
  const stale: LedgerEntry = { ...decided('accepted-debt', '2026-02-01T00:00:00.000Z') };
  const other: LedgerEntry = { ...stale, fingerprint: 'ffffffffffffffff' };
  const result = sync({ entries: [other], findings: [] });
  assert.equal(result.entries.length, 1);
  assert.equal(result.entries[0]?.status, 'accepted-debt');
  assert.equal(result.entries[0]?.lastSeen, '2026-01-01T00:00:00.000Z');
});

test('решение записывается и не теряет остальные записи', () => {
  const first = sync({
    findings: [FOUND, trackFinding({ ...BASE, id: 'F2', evidence: 'другое' })],
  });
  assert.equal(first.entries.length, 2);
  const after = decide(first.entries, FOUND.fingerprint, 'accepted-debt', {
    note: 'меняем в следующем релизе',
    now: at('2026-09-14T12:00:00.000Z'),
  });
  assert.equal(after.length, 2);
  const target = after.find((entry) => entry.fingerprint === FOUND.fingerprint);
  const untouched = after.find((entry) => entry.fingerprint !== FOUND.fingerprint);
  assert.equal(target?.status, 'accepted-debt');
  assert.equal(target?.decidedAt, '2026-09-14T12:00:00.000Z');
  assert.equal(target?.note, 'меняем в следующем релизе');
  assert.equal(untouched?.status, 'new');
});

test('решение по неизвестному отпечатку — ошибка, а не тишина', () => {
  assert.throws(
    () => decide([], 'deadbeefdeadbeef', 'accepted-debt', { now: at('2026-09-14T12:00:00.000Z') }),
    /нет находки с отпечатком/,
  );
});

test('журнал переживает запись и чтение, и решение продолжает молчать', async () => {
  // Сквозная проверка этапа: решение принято в одном прогоне, а экономит во втором — после того,
  // как прошло через файл.
  const dir = mkdtempSync(path.join(ensureTmp(), 'ledger-'));
  try {
    const store = new JsonFindingStore(path.join(dir, 'findings.json'));
    assert.deepEqual(await store.load(), []);
    const first = sync();
    const answered = decide(first.entries, FOUND.fingerprint, 'accepted-debt', {
      note: 'осознанно',
      now: at('2026-09-14T12:00:00.000Z'),
    });
    await store.save(answered);

    const loaded = await store.load();
    assert.equal(loaded.length, 1);
    assert.equal(loaded[0]?.note, 'осознанно');
    assert.equal(loaded[0]?.policy, 'P-dead-code');
    const second = sync({ entries: loaded, now: at('2026-09-15T10:00:00.000Z') });
    assert.equal(second.fresh.length, 0);
    assert.equal(second.suppressed.length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('испорченный файл журнала роняет загрузку, а не подменяется пустым', async () => {
  // Пустой журнал вместо испорченного — это стёртые решения человека без единого сообщения.
  const dir = mkdtempSync(path.join(ensureTmp(), 'ledger-'));
  try {
    const file = path.join(dir, 'broken.json');
    await writeFile(file, '{ это не json', 'utf8');
    await assert.rejects(() => new JsonFindingStore(file).load(), /не читается как JSON/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('неизвестный статус в файле называется по имени', async () => {
  // Журнал правят руками: опечатка в статусе не должна превращаться в молчаливое подавление.
  const dir = mkdtempSync(path.join(ensureTmp(), 'ledger-'));
  try {
    const file = path.join(dir, 'findings.json');
    const store = new JsonFindingStore(file);
    await store.save([decided('accepted-debt', '2026-02-01T00:00:00.000Z')]);
    const text = await readFile(file, 'utf8');
    await writeFile(file, text.replace('"accepted-debt"', '"принято"'), 'utf8');
    await assert.rejects(() => store.load(), /неизвестный статус/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function ensureTmp(): string {
  // Заготовки живут в рабочем каталоге прогона, а не в системном временном: он вне истории, но
  // виден человеку, если тест упал и файл захотелось открыть.
  const base = path.join(REPO, '.maintenance', 'tmp');
  mkdirSync(base, { recursive: true });
  return base;
}
