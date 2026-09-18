import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { readDeviceMailConfig } from '../src/device-mail/config';
import { readDirMailboxState } from '../src/device-mail/mailbox-dir';
import { startDeviceMailPoller } from '../src/device-mail/poller';
import {
  DeviceMailPausedError,
  type DeviceMailApi,
  type DeviceMailConfig,
  type DeviceMailSubmission,
  type DeviceMailbox,
} from '../src/device-mail';

/**
 * Приёмник писем от оргтехники на транспорте `dir` (Р27), ручка — подставная.
 *
 * Проверяется здесь не «код работает», а ПОРЯДОК ШАГОВ (§9.1 плана
 * `docs/office-equipment-mail-telemetry-plan.md`): курсор, потолок размера, стоп-граница и
 * отметка прочитанного после ответа. Каждый из них написан по разобранному сценарию потери
 * письма, и приёмник, молча съедающий всё подряд, прошёл бы «проверку на зелёное» идеально.
 */

type Behavior = 'pause' | 'terminal';

function createStubApi() {
  // Курсор живёт в API, а не в worker (Р23): здесь он и хранится — так же, как строка
  // `device_mail_accounts` в базе портала.
  const state = { uidValidity: 0, lastUid: 0 };
  const submissions: DeviceMailSubmission[] = [];
  const behavior = new Map<number, Behavior>();

  const cursorCalls: (string | undefined)[] = [];

  const api: DeviceMailApi = {
    async cursor(_account, mailboxError) {
      cursorCalls.push(mailboxError);
      return {
        uidValidity: state.uidValidity,
        lastUid: state.lastUid,
        resetUidValidity: null,
        resetMaxUid: null,
        stuckUidValidity: null,
        stuckUid: null,
        stuckAttempts: 0,
      };
    },
    async submit(message) {
      if (behavior.get(message.uid) === 'pause') {
        // «Портал целиком не принимает»: строки нет, курсор не двигается.
        throw new DeviceMailPausedError('Приём писем приостановлен: API ответил 503');
      }
      submissions.push(message);
      state.uidValidity = message.uidValidity;
      state.lastUid = Math.max(state.lastUid, message.uid);
      // Терминальный исход ручка закрывает САМА из уже полученного тела и отвечает УСПЕХОМ —
      // потому такое письмо пачку и не прекращает.
      const status =
        behavior.get(message.uid) === 'terminal'
          ? 'failed'
          : message.skipReason
            ? 'ignored'
            : 'received';
      return { outcome: 'created' as const, status, lastUid: state.lastUid };
    },
  };

  return { api, state, submissions, behavior, cursorCalls };
}

interface SpyLetter {
  uid: number;
  size?: number;
}

/**
 * Ящик-шпион: журнал вызовов и поведение РАБОЧЕГО транспорта, а не удобное.
 *
 * Две вещи здесь несущие. Первая: прочитанных он НЕ скрывает — ровно как IMAP, который перечисляет
 * `fromUid:*` и флаг `\Seen` не фильтрует ничем. Скрывай он их, и «виденный UID не берётся второй
 * раз» держалось бы на ящике, а не на курсоре: приёмник, читающий каждый тик с единицы, прошёл бы
 * ворота, а на проде сдавал бы ручке весь ящик заново каждые пять минут. Вторая: журнал вызовов
 * даёт утверждать, чего приёмник НЕ делал, — без него «тело переростка не качается вовсе»
 * проверить нечем, и реализация, качающая пять мегабайт в мусор, зелёная.
 */
function createSpyMailbox(letters: SpyLetter[], uidValidity = 777) {
  const calls: {
    op: 'open' | 'list' | 'fetchRaw' | 'markProcessed';
    uid?: number;
    fromUid?: number;
  }[] = [];
  // Отказ ящика, включаемый на ходу: неверный пароль, не договорившийся TLS, недоступный узел.
  const failure = { message: '' };

  const mailbox: DeviceMailbox = {
    name: 'imap',
    async open() {
      calls.push({ op: 'open' });
      if (failure.message) throw new Error(failure.message);
      const uids = letters.map((l) => l.uid);
      return { uidValidity, maxUid: uids.length > 0 ? Math.max(...uids) : null };
    },
    async listEnvelopes(fromUid, limit) {
      calls.push({ op: 'list', fromUid });
      return letters
        .filter((l) => l.uid >= fromUid)
        .sort((a, b) => a.uid - b.uid)
        .slice(0, limit)
        .map((l) => ({
          uid: l.uid,
          size: l.size ?? 128,
          messageIdHeader: `<${l.uid}@spy.test>`,
        }));
    },
    async fetchRaw(uid) {
      calls.push({ op: 'fetchRaw', uid });
      return letters.some((l) => l.uid === uid) ? Buffer.from(`тело ${uid}`, 'utf8') : null;
    },
    async markProcessed(uid) {
      calls.push({ op: 'markProcessed', uid });
    },
    async close() {},
  };

  return { mailbox, calls, failure };
}

/** Путь файла состояния транспорта `dir` — то же имя, что строит `mailbox-dir.ts`. */
function stateFileOf(dir: string): string {
  return join(dirname(dir), `${basename(dir)}.device-mail-state.json`);
}

function writeEml(dir: string, name: string, body: string): void {
  writeFileSync(
    join(dir, name),
    [
      'From: mfp@example.test',
      'To: devices@example.test',
      `Message-ID: <${name}@example.test>`,
      'Date: Wed, 17 Sep 2026 09:00:00 +0300',
      'Subject: Device report',
      '',
      body,
      '',
    ].join('\r\n'),
    'utf8',
  );
}

describe('приёмник писем оргтехники', () => {
  let dir = '';
  let config: DeviceMailConfig;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'device-mail-'));
    const parsed = readDeviceMailConfig({
      DEVICE_MAIL_ENABLED: 'true',
      DEVICE_MAIL_TRANSPORT: 'dir',
      DEVICE_MAIL_DIR: dir,
      DEVICE_MAIL_ACCOUNT: 'pilot',
      DEVICE_MAIL_BATCH: '10',
      // Потолок нарочно маленький: переросток изображается килобайтами, а не мегабайтами.
      DEVICE_MAIL_MAX_SIZE_BYTES: '2048',
    } as NodeJS.ProcessEnv);
    if (!parsed) throw new Error('Настройки приёма не собрались');
    config = parsed;
    warnings = [];
  });

  let warnings: string[] = [];

  function poller(api: DeviceMailApi, mailbox?: DeviceMailbox) {
    return startDeviceMailPoller({
      config,
      apiBaseUrl: 'http://api.invalid',
      internalToken: 'test',
      log: () => {},
      warn: (_meta, msg) => warnings.push(msg),
      api,
      ...(mailbox ? { mailbox } : {}),
    });
  }

  it('виденный UID не берётся второй раз', async () => {
    writeEml(dir, '01.eml', 'первое');
    writeEml(dir, '02.eml', 'второе');
    const stub = createStubApi();

    const first = await poller(stub.api).tick();
    expect(first.accepted).toBe(2);
    expect(stub.submissions.map((m) => m.uid)).toEqual([1, 2]);

    // Второй заход по тому же ящику: писем нет — курсор стоит на двойке.
    const second = await poller(stub.api).tick();
    expect(second.taken).toBe(0);
    expect(stub.submissions).toHaveLength(2);

    // Дописали третье — берётся только оно.
    writeEml(dir, '03.eml', 'третье');
    const third = await poller(stub.api).tick();
    expect(third.accepted).toBe(1);
    expect(stub.submissions.map((m) => m.uid)).toEqual([1, 2, 3]);
    expect(stub.state.lastUid).toBe(3);
  });

  it('второй заход спрашивает ящик от курсора, а не с начала', async () => {
    // Ящик-шпион прочитанных не скрывает, как и настоящий: отбор держит ТОЛЬКО курсор. Замени
    // `fromUid` единицей — и тот же ящик уехал бы в ручку повторно, а этот случай станет красным.
    const spy = createSpyMailbox([{ uid: 1 }, { uid: 2 }]);
    const stub = createStubApi();
    const running = poller(stub.api, spy.mailbox);

    await running.tick();
    await running.tick();

    // Первый заход — с единицы (строки ящика в базе ещё нет), второй — с `last_uid + 1`.
    expect(spy.calls.filter((c) => c.op === 'list').map((c) => c.fromUid)).toEqual([1, 3]);
    expect(stub.submissions.map((m) => m.uid)).toEqual([1, 2]);
    expect(stub.state.lastUid).toBe(2);
  });

  it('тело переростка не качается вовсе', async () => {
    // Потолок захода — 2048 байт; первое письмо объявлено тяжелее.
    const spy = createSpyMailbox([
      { uid: 1, size: 5_000 },
      { uid: 2, size: 128 },
    ]);
    const stub = createStubApi();

    await poller(stub.api, spy.mailbox).tick();

    // Утверждение про то, чего приёмник НЕ делал: у переростка тело не спрашивалось ни разу.
    // Реализация, качающая его и выбрасывающая, тратит пять мегабайт трафика каждый заход — а по
    // одному отсутствию `rawBase64` она неотличима от правильной.
    expect(spy.calls.filter((c) => c.op === 'fetchRaw').map((c) => c.uid)).toEqual([2]);
    expect(stub.submissions[0]?.skipReason).toBe('too_large');
    expect(stub.submissions[0]?.rawBase64).toBeUndefined();
  });

  it('отказ ящика называется своим именем и уезжает ручке', async () => {
    const spy = createSpyMailbox([{ uid: 1 }]);
    spy.failure.message = 'Неверный пароль ящика';
    const stub = createStubApi();
    const running = poller(stub.api, spy.mailbox);

    const first = await running.tick();

    // Тик не падает, но и не врёт: причина названа ящиком, а не «API не ответил» — при живом API
    // опечатку в `prod.env` иначе ищут не там.
    expect(first.mailboxError).toContain('Неверный пароль');
    expect(warnings).toContain('Ящик оргтехники не читается');
    expect(stub.submissions).toHaveLength(0);

    // Своей строки состояния у worker нет: причина уходит ручке следующим запросом курсора, иначе
    // `last_error` ящика не заполнит никто и мёртвый контур не виден нигде (§9.1, п. 8).
    spy.failure.message = '';
    await running.tick();
    expect(stub.cursorCalls).toEqual([undefined, 'Неверный пароль ящика']);
    expect(stub.submissions.map((m) => m.uid)).toEqual([1]);
  });

  it('потеря файла состояния выдаёт новую эпоху, а не тихо теряет письмо', async () => {
    writeEml(dir, '01.eml', 'первое');
    writeEml(dir, '02.eml', 'второе');
    const stub = createStubApi();

    await poller(stub.api).tick();
    const firstEpoch = stub.state.uidValidity;
    expect(stub.state.lastUid).toBe(2);

    // Состояние снесено — чистка `tmp`, переустановка, битый JSON, — и в каталог лёг файл,
    // сортирующийся раньше прочих. Выводись эпоха из пути, он получил бы UID 1, то есть НИЖЕ
    // курсора, и не был бы сдан никогда: ни строки в базе, ни предупреждения.
    rmSync(stateFileOf(dir));
    expect(readDirMailboxState(dir)).toBeNull();
    writeEml(dir, '00-new.eml', 'новое');

    const second = await poller(stub.api).tick();

    expect(second.mailboxError).toBeUndefined();
    expect(stub.state.uidValidity).not.toBe(firstEpoch);
    // Новая эпоха переводит случай в описанный: ручка сбросит курсор, а отметка Р32 приедет
    // готовой — весь каталог перечитывается под барьером дедупликации, и новое письмо среди него.
    const fresh = stub.submissions.filter((m) => m.uidValidity === stub.state.uidValidity);
    expect(fresh.map((m) => m.messageIdHeader)).toContain('<00-new.eml@example.test>');
    expect(fresh.map((m) => m.mailboxMaxUid)).toEqual([3, 3, 3]);
  });

  it('терминальный отказ одного письма не прекращает пачку', async () => {
    writeEml(dir, '01.eml', 'первое');
    writeEml(dir, '02.eml', 'битое');
    writeEml(dir, '03.eml', 'третье');
    const stub = createStubApi();
    // Ручка закрыла второе письмо сама: `failed` с причиной и успешный ответ.
    stub.behavior.set(2, 'terminal');

    const result = await poller(stub.api).tick();

    expect(result.accepted).toBe(3);
    expect(result.paused).toBe(false);
    expect(stub.submissions.map((m) => m.uid)).toEqual([1, 2, 3]);
    expect(stub.state.lastUid).toBe(3);
  });

  it('временный отказ прекращает пачку, и курсор не двигается', async () => {
    writeEml(dir, '01.eml', 'первое');
    writeEml(dir, '02.eml', 'второе');
    writeEml(dir, '03.eml', 'третье');
    const stub = createStubApi();
    stub.behavior.set(2, 'pause');

    const result = await poller(stub.api).tick();

    expect(result.paused).toBe(true);
    // Третье письмо не сдано: продолжить после стоп-границы значит увести курсор за непринятое
    // второе и потерять его навсегда.
    expect(stub.submissions.map((m) => m.uid)).toEqual([1]);
    expect(stub.state.lastUid).toBe(1);

    // Портал включили — письмо дождалось в ящике, и пачка пошла с него же.
    stub.behavior.delete(2);
    const second = await poller(stub.api).tick();
    expect(second.paused).toBe(false);
    expect(stub.submissions.map((m) => m.uid)).toEqual([1, 2, 3]);
    expect(stub.state.lastUid).toBe(3);
  });

  it('письмо сверх потолка уходит конвертом без сырья и не задерживает курсор', async () => {
    writeEml(dir, '01.eml', 'x'.repeat(4096));
    writeEml(dir, '02.eml', 'второе');
    const stub = createStubApi();

    const result = await poller(stub.api).tick();

    expect(result.skipped).toBe(1);
    const [big, small] = stub.submissions;
    expect(big?.uid).toBe(1);
    expect(big?.rawBase64).toBeUndefined();
    expect(big?.skipReason).toBe('too_large');
    // Конверт при этом сдан целиком: без размера и заголовков строка `ignored` не расскажет ничего.
    expect(big?.size).toBeGreaterThan(config.maxSizeBytes);
    expect(big?.messageIdHeader).toBe('<01.eml@example.test>');
    expect(small?.rawBase64).toBeTruthy();
    // Курсор переехал переростка, а не встал на нём: иначе одно тяжёлое письмо вытесняло бы свежие.
    expect(stub.state.lastUid).toBe(2);
  });

  it('письмо помечается прочитанным только после успешного ответа', async () => {
    writeEml(dir, '01.eml', 'первое');
    writeEml(dir, '02.eml', 'второе');
    const stub = createStubApi();
    stub.behavior.set(2, 'pause');

    await poller(stub.api).tick();

    // Первое принято — помечено; второе ручка не приняла, и в ящике оно осталось непрочитанным.
    expect(readDirMailboxState(dir)?.seen ?? []).toEqual([1]);

    stub.behavior.delete(2);
    await poller(stub.api).tick();
    expect(readDirMailboxState(dir)?.seen ?? []).toEqual([1, 2]);
  });

  it('в теле сдачи едет верхняя граница ящика', async () => {
    writeEml(dir, '01.eml', 'первое');
    writeEml(dir, '02.eml', 'второе');
    writeEml(dir, '03.eml', 'третье');
    const stub = createStubApi();
    // Пачка прекратится на втором письме — тем нагляднее, что отметка про ЯЩИК, а не про пачку.
    stub.behavior.set(2, 'pause');

    await poller(stub.api).tick();

    // Отметка Р32 — наибольший номер каталога фикстур, и она едет уже с первым письмом: запишет её
    // ручка при сбросе курсора, а увидеть ящик может только worker.
    expect(stub.submissions.map((m) => m.mailboxMaxUid)).toEqual([3]);
  });

  it('тело письма уходит в ручку целиком и байт в байт', async () => {
    writeEml(dir, '01.eml', 'показания');
    const stub = createStubApi();

    await poller(stub.api).tick();

    const raw = Buffer.from(stub.submissions[0]?.rawBase64 ?? '', 'base64').toString('utf8');
    // Ни одной строки разбора: worker отдаёт письмо как есть, вместе с шапкой.
    expect(raw).toContain('Subject: Device report');
    expect(raw).toContain('показания');
  });
});
