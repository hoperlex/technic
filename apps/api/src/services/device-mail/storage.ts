import { randomUUID } from 'node:crypto';
import { GetObjectCommand } from '@aws-sdk/client-s3';
import { config } from '../../config';
import type { db } from '../../db/client';
import { JOB_DELETE_S3_OBJECT, enqueueJob } from '../../lib/jobs';
import { putObject, s3 } from '../../lib/s3';

/**
 * Сырьё письма аппарата в хранилище (план `docs/office-equipment-mail-telemetry-plan.md`, Р25,
 * Р26, Р31).
 *
 * СВОЙ ПОСТРОИТЕЛЬ КЛЮЧА, А НЕ `buildObjectKey`. У той функции префикс `waste-requests/` зашит в
 * тело, и расширять её вторым аргументом ради телеметрии значило бы трогать путь чужих файлов —
 * то есть путь всех сканов талонов сразу. Форма ключа та же, какой её задумала соседка:
 * `device-mail/<ГГГГ>/<ММ>/<uuid>.eml`.
 *
 * В ОБЩУЮ ТАБЛИЦУ `files` СЫРЬЁ НЕ ИДЁТ. Там карантин, права и ссылки на заявки, а письмо
 * аппарата — не файл пользователя: его никто не загружал, никому не показывает и через месяц оно
 * исчезнет. Поэтому и ключ объекта лежит прямо в строке письма (`s3_object_key`), а состояние
 * сырья — отдельным признаком (`raw_state`).
 *
 * УБОРКА — ОТЛОЖЕННОЙ ЗАДАЧЕЙ `delete_s3_object`, которая в очереди уже есть (Р31). Своего срока
 * хранения у писем нет и не заводится: один механизм на все объекты портала, и разойтись двум
 * уборщикам негде.
 */

/** Тип сырого письма: ровно тот, которым его отдаёт IMAP. */
export const DEVICE_MAIL_CONTENT_TYPE = 'message/rfc822';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Ключ объекта письма. Год и месяц — из момента приёма: по ним сырьё раскладывается так же, как
 * файлы заявок, и ручная уборка хранилища за старый месяц остаётся возможной.
 */
export function buildDeviceMailObjectKey(now: Date = new Date()): string {
  const yyyy = now.getUTCFullYear();
  const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
  return `device-mail/${yyyy}/${mm}/${randomUUID()}.eml`;
}

/**
 * Запись сырья. Тело буфером, а не потоком: письмо ограничено потолком в несколько мегабайт, и
 * поток здесь дал бы только возможность записать половину.
 */
export async function putDeviceMailRaw(objectKey: string, raw: Buffer): Promise<void> {
  await putObject(objectKey, raw, DEVICE_MAIL_CONTENT_TYPE);
}

/**
 * Чтение сырья — им живёт перечитывание (Р26): «производные данные пересчитать можно, источник —
 * нет».
 *
 * Отсутствующий объект — `null`, а не исключение. Строка может уверять, что сырьё сложено, а
 * объекта уже не быть: уборка ходит отдельной задачей, и гонка «удалили ровно сейчас» ничем не
 * запрещена. Вызывающий обязан различать «нечем перечитать» и «хранилище лежит», а исключение
 * склеило бы эти два исхода в один.
 */
export async function getDeviceMailRaw(objectKey: string): Promise<Buffer | null> {
  try {
    const res = await s3.send(new GetObjectCommand({ Bucket: config.s3.bucket, Key: objectKey }));
    const body = res.Body;
    if (!body) return null;
    const bytes = await body.transformToByteArray();
    return Buffer.from(bytes);
  } catch (e) {
    const name = (e as { name?: string }).name;
    if (name === 'NoSuchKey' || name === 'NotFound') return null;
    throw e;
  }
}

/** Транзакция drizzle: задача уборки обязана появиться тем же коммитом, что и ключ объекта. */
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Отложенное удаление сырья через `DEVICE_MAIL_RAW_TTL_DAYS`.
 *
 * СРОК СЧИТАЕТСЯ ОТ ПРИЁМА, А НЕ ОТ «СЕЙЧАС», и не может уехать в прошлое: `max(получено + TTL,
 * сейчас)`. На горячем приёме это одно и то же, а вот пакетный прогон накопленного (Р31) ставит
 * задачу письмам месячной давности — «сейчас плюс TTL» подарил бы им второй срок хранения, а
 * «получено плюс TTL» без нижней границы поставило бы задачу в прошлое.
 *
 * Ставится ТЕМ ЖЕ КОММИТОМ, которым строка письма узнаёт про ключ объекта. Иначе падение между
 * двумя записями оставляет в хранилище тело письма, которое не удалит уже никто: уборщик ходит по
 * задачам, а не по строкам.
 */
export async function scheduleDeviceMailRawCleanup(
  tx: Tx,
  objectKey: string,
  receivedAt: Date = new Date(),
): Promise<void> {
  const due = new Date(receivedAt.getTime() + config.deviceMail.rawTtlDays * DAY_MS);
  const runAt = due.getTime() > Date.now() ? due : new Date();
  await enqueueJob(JOB_DELETE_S3_OBJECT, { objectKey }, { runAt, tx });
}
