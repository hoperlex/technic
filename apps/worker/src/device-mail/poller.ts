import type { DeviceSkipReason } from '@technic/contracts';
import { createDeviceMailApi, type DeviceMailApi } from './intake-client';
import { createDirMailbox } from './mailbox-dir';
import { createImapMailbox } from './mailbox-imap';
import { DeviceMailPausedError, type DeviceMailConfig, type DeviceMailbox } from './types';

/**
 * Приёмник писем от оргтехники: спросить курсор, забрать письмо из ящика, отдать его API целиком
 * (план `docs/office-equipment-mail-telemetry-plan.md`, §9.1 — протокол приёма по шагам).
 *
 * Три действия, и разбора среди них нет ни одного (Р2). В базу worker не ходит, в хранилище не
 * пишет: сырьё кладёт API (Р25), курсор двигает та же ручка, что принимает письмо. Здесь только
 * транспорт и порядок шагов — а порядок здесь и есть всё содержание: пять кругов ревью били
 * ровно в него.
 */

/**
 * Причина «конверт без сырья» берётся из контракта, а не пишется литералом: ручка и приёмник живут
 * в разных приложениях, и разошедшиеся строки развели бы их молча.
 */
const DEVICE_SKIP_REASON_TOO_LARGE: DeviceSkipReason = 'too_large';

export interface DeviceMailPollerDeps {
  config: DeviceMailConfig;
  /** База API внутри сети — та же, что у часов рассылок. */
  apiBaseUrl: string;
  internalToken: string;
  log: (meta: Record<string, unknown>, msg: string) => void;
  warn: (meta: Record<string, unknown>, msg: string) => void;
  /**
   * Подмена ящика и ручки. Ящик подменяется настройкой (Р27) и этим полем — тестом; ручка
   * подменяется только тестом. Без обеих подмен приёмник не проверяется вовсе: IMAP-сервера нет
   * ни в тестах, ни у разработчика.
   */
  mailbox?: DeviceMailbox;
  api?: DeviceMailApi;
}

export interface DeviceMailTickResult {
  /** Сколько конвертов взято у ящика в этом заходе. */
  taken: number;
  /** Сколько писем ручка приняла (включая собственные повторы — это штатный успех). */
  accepted: number;
  /** Сколько сдано конвертом без сырья: переростки, тело которых не качалось вовсе. */
  skipped: number;
  /** Сколько писем исчезло из ящика между перечнем и скачиванием. */
  vanished: number;
  /** Пачка прекращена стоп-границей: письмо осталось в ящике, курсор не двинулся. */
  paused: boolean;
  /** Курсор после захода — по ответу ручки; не сдвинулся ни разу, значит как был. */
  lastUid: number;
  /**
   * Заход не состоялся из-за ЯЩИКА: не открылся, оборвалось перечисление или скачивание. Отдельно
   * от отказа ручки, потому что лечится это другим и другими людьми: неверный пароль в `prod.env`,
   * не договорившийся TLS, недоступный узел. Причина уходит ручке следующим запросом курсора,
   * чтобы `last_error` ящика заполнялся и в этой ветке (§9.1, п. 8).
   */
  mailboxError?: string;
}

export interface DeviceMailPoller {
  /** Один заход в ящик. Не бросает на отказе приёма: отказ — это исход захода, а не сбой worker. */
  tick(): Promise<DeviceMailTickResult>;
  /** Как часто заходить. Само время держит цикл worker — см. примечание ниже. */
  readonly intervalMs: number;
  stop(): Promise<void>;
}

function createMailbox(deps: DeviceMailPollerDeps): DeviceMailbox {
  if (deps.mailbox) return deps.mailbox;
  return deps.config.transport === 'dir'
    ? createDirMailbox(deps.config)
    : createImapMailbox(deps.config, deps.warn);
}

/**
 * Собрать приёмник. Своего таймера у него нет намеренно: время в worker держит один цикл, и второй
 * источник тиков просыпался бы во время остановки и посреди долгой пачки задач. Отсюда форма
 * «тик наружу» — та же, что у часов рассылок (`mail-scheduler.ts`).
 */
export function startDeviceMailPoller(deps: DeviceMailPollerDeps): DeviceMailPoller {
  const { config } = deps;
  const api = deps.api ?? createDeviceMailApi(deps.apiBaseUrl, deps.internalToken);
  const mailbox = createMailbox(deps);
  /**
   * Причина, по которой прошлый заход не состоялся. Держится до следующего запроса курсора и
   * уходит ручке им же: своей строки состояния у worker нет, и рассказать про недоступный ящик он
   * может только тому, у кого эта строка есть. Иначе ящик, не читаемый месяц из-за опечатки в
   * пароле, не виден правдой нигде — ни в портале, ни в журнале.
   */
  let pendingMailboxError = '';

  async function tick(): Promise<DeviceMailTickResult> {
    // Шаг 1. Курсор спрашивается ДО ящика: без него неизвестно, с какого номера читать, и заходить
    // в ящик незачем.
    const cursor = await api.cursor(config.account, pendingMailboxError || undefined);
    // Рассказано — забываем: держать причину дольше значит писать в `last_error` вчерашнюю беду
    // поверх сегодняшней работы.
    pendingMailboxError = '';
    const result: DeviceMailTickResult = {
      taken: 0,
      accepted: 0,
      skipped: 0,
      vanished: 0,
      paused: false,
      lastUid: cursor.lastUid,
    };

    try {
      // Ящик открывается ВНУТРИ этой попытки: его отказ — отдельная ветка исхода, а не сбой тика.
      const { uidValidity, maxUid } = await mailbox.open();
      // Эпоха разошлась — ящик пересоздан: номера прежнего ящика к новому не относятся ни одним
      // числом, и читать надо с начала. Курсор сбрасывает и барьер дедупликации ставит ручка
      // (Р32) — worker про дубли не знает ничего, у него нет базы.
      const freshEpoch = cursor.uidValidity !== uidValidity;
      // Молчим, когда эпохи ещё не было (`0`): строки ящика в базе нет, и это штатное состояние
      // выката Э2, а не пересоздание. Предупреждай о нём — и каждые пять минут в журнале стояла бы
      // неправда, обесценивая заодно предупреждения о настоящих бедах ящика.
      if (freshEpoch && cursor.uidValidity > 0) {
        deps.warn(
          { account: config.account, was: cursor.uidValidity, now: uidValidity },
          'Ящик оргтехники пересоздан: читаем сначала',
        );
      }
      const fromUid = freshEpoch ? 1 : cursor.lastUid + 1;

      if (cursor.stuckAttempts > 0 && cursor.stuckUidValidity === uidValidity) {
        // Закрывает застрявшее письмо ручка, на своём же следующем заходе (§9.1, п. 7). Worker
        // только говорит вслух, что курсор стоит: иначе мёртвый контур не виден нигде.
        deps.warn(
          { account: config.account, uid: cursor.stuckUid, attempts: cursor.stuckAttempts },
          'Курсор ящика оргтехники стоит на письме',
        );
      }

      // Шаг 2. Конверты без тел, от курсора вверх, пачкой.
      const envelopes = await mailbox.listEnvelopes(fromUid, config.batch);
      result.taken = envelopes.length;

      for (const envelope of envelopes) {
        // Шаг 3. Переросток: тело НЕ качается вовсе — размер виден в конверте. Это единственный
        // случай конверта без сырья; ручка заведёт строку `ignored` и курсор поедет дальше.
        // Качай мы его — одно тяжёлое письмо всплывало бы в каждой пачке и вытесняло свежие.
        const tooLarge = envelope.size > config.maxSizeBytes;
        let rawBase64: string | undefined;
        if (!tooLarge) {
          // Шаг 4. Иначе письмо качается целиком и уходит в ручку одним вызовом.
          const raw = await mailbox.fetchRaw(envelope.uid);
          if (!raw) {
            // Письма больше нет в ящике — его убрали руками между перечнем и скачиванием. Сдавать
            // нечего, и это не повод останавливать пачку: курсор переедет следующим письмом.
            result.vanished += 1;
            deps.warn(
              { account: config.account, uid: envelope.uid },
              'Письмо исчезло из ящика до скачивания',
            );
            continue;
          }
          rawBase64 = raw.toString('base64');
        }

        try {
          const accepted = await api.submit({
            account: config.account,
            uidValidity,
            uid: envelope.uid,
            size: envelope.size,
            messageIdHeader: envelope.messageIdHeader,
            dateHeader: envelope.dateHeader,
            envelopeTo: envelope.envelopeTo,
            // Верхняя граница ящика — отметка Р32, и записать её может только тот, кто ящик
            // видит. Не знаем границы — поля нет вовсе: ручка оставит барьер выключенным, а ноль
            // выключил бы его молча и навсегда.
            ...(maxUid === null ? {} : { mailboxMaxUid: maxUid }),
            ...(rawBase64 === undefined
              ? { skipReason: DEVICE_SKIP_REASON_TOO_LARGE }
              : { rawBase64 }),
          });
          result.accepted += 1;
          if (tooLarge) result.skipped += 1;
          result.lastUid = accepted.lastUid;
        } catch (e) {
          // Шаг 6. Стоп-граница. Временный отказ означает «портал не принимает»: письмо остаётся в
          // ящике, курсор стоит, пачка прекращается. Продолжить после него — значит увести
          // курсор за непринятое письмо и потерять его навсегда.
          //
          // Терминальный исход сюда не приходит: его ручка закрывает сама из уже полученного тела
          // и отвечает успехом (§9.1, п. 6). Потому такое письмо пачку и не прекращает.
          result.paused = true;
          const message = e instanceof Error ? e.message : String(e);
          if (e instanceof DeviceMailPausedError) {
            deps.warn({ account: config.account, uid: envelope.uid }, message);
          } else {
            deps.warn(
              { account: config.account, uid: envelope.uid, err: message },
              'Письмо не сдано',
            );
          }
          break;
        }

        // Шаг 5. Помечаем ПОСЛЕ успешного ответа, а не до. Наоборот — значит терять письмо на
        // каждом потерянном ответе: тело выкачано, письмо прочитано, а в базе его нет.
        try {
          await mailbox.markProcessed(envelope.uid);
        } catch (e) {
          // Письмо принято и курсор уехал — повторно его никто не возьмёт. Значит отметка уже
          // ничего не решает, и ронять из-за неё остаток пачки незачем; но молчать нельзя:
          // непомеченное письмо копится в ящике и однажды упрётся в квоту.
          deps.warn(
            {
              account: config.account,
              uid: envelope.uid,
              err: e instanceof Error ? e.message : String(e),
            },
            'Письмо принято, но не помечено обработанным',
          );
        }
      }
    } catch (e) {
      // Сюда доходят только отказы ЯЩИКА: и сдача письма, и отметка разобраны внутри цикла. Текст
      // обязан отличаться от «API не ответил»: опечатка в пароле ящика иначе читается как беда
      // портала, и её ищут не там — при живом API, пустой базе и нерастущем счётчике.
      result.mailboxError = e instanceof Error ? e.message : String(e);
      pendingMailboxError = result.mailboxError;
      deps.warn(
        { account: config.account, transport: mailbox.name, err: result.mailboxError },
        'Ящик оргтехники не читается',
      );
    } finally {
      await mailbox.close();
    }

    return result;
  }

  return {
    tick,
    intervalMs: config.pollIntervalMs,
    async stop() {
      await mailbox.close();
    },
  };
}
