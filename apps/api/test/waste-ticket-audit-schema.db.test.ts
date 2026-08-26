import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applyMigrations } from '../src/db/migration-journal';

/**
 * Инварианты наблюдения — то, что держит база, а не код (миграция 0210, план §1.1, §2.1).
 *
 * Зачем отдельным файлом и без поднятого приложения. Проверяется здесь ровно то, что обязано
 * пережить любую будущую правку маршрутов: связь указывает на наблюдение того же поля, основание
 * метрики нельзя удалить из-под адресованного ему решения, а машинное чтение не может само на себя
 * ссылаться. Напиши это тестом маршрута — и тест останется зелёным ровно тогда, когда маршрут
 * перестанет писать связи вовсе.
 *
 * Вторая половина — версия сбора. Прежние события собраны кодом, который не знал ни исхода, ни
 * признака прочтения; инварианты второй версии обязаны отбивать новое и пропускать старое, иначе
 * миграция упала бы на собственной истории.
 *
 * Запуск:
 *
 *   TEST_DATABASE_URL=postgres://technic:technic@localhost:5433/technic_audit_test \
 *     pnpm --filter @technic/api test waste-ticket-audit-schema.db
 */

const DB_URL = process.env.TEST_DATABASE_URL;
const RUN = randomUUID().slice(0, 8);

let client: pg.Client;
/** Наблюдение по объёму: к нему адресуются решения, на него ссылаются связи. */
let observationId: string;
let ticketId: string;
let blindCheckId: string;

/** Ожидаем отказ базы с конкретным ограничением: «упало хоть как-то» — не проверка. */
async function rejectedBy(sql: string, params: unknown[], constraint: string): Promise<void> {
  await client.query('BEGIN');
  try {
    await client.query(sql, params);
    throw new Error(`ожидался отказ ограничения ${constraint}, а запрос прошёл`);
  } catch (error) {
    expect(String((error as { constraint?: string }).constraint ?? error)).toContain(constraint);
  } finally {
    await client.query('ROLLBACK');
  }
}

describe.skipIf(!DB_URL)('наблюдения распознавания: инварианты схемы (0210)', () => {
  beforeAll(async () => {
    client = new pg.Client({ connectionString: DB_URL });
    await client.connect();
    await applyMigrations(client);

    const object = await client.query<{ id: string }>(
      `INSERT INTO construction_objects (code, name) VALUES ($1, $2) RETURNING id`,
      [`AUD-${RUN}`, `Аудит ${RUN}`],
    );
    const user = await client.query<{ id: string }>(
      // `full_name` вычисляемая — задать её нельзя, и это не мелочь фикстуры, а причина, по
      // которой пользователь заводится сырым SQL, а не копией доменного помощника.
      `INSERT INTO users (email, password_hash, last_name, first_name)
       VALUES ($1, 'x', 'Аудит', 'Тест') RETURNING id`,
      [`audit-${RUN}@example.test`],
    );
    const request = await client.query<{ id: string }>(
      // `num` тоже вычисляемая: номер заявке даёт база, а не тот, кто её заводит.
      `INSERT INTO waste_requests (object_id, request_type, delivery_at, created_by, status, comment)
       VALUES ($1, 'waste_removal', now(), $2, 'done', $3) RETURNING id`,
      [object.rows[0]!.id, user.rows[0]!.id, `audit-${RUN}`],
    );
    const ticket = await client.query<{ id: string }>(
      `INSERT INTO waste_tickets (request_id, origin, status, number_raw, number_key, volume_m3, work_kind)
       VALUES ($1, 'ocr', 'unconfirmed', $2, $2, '20', 'removal') RETURNING id`,
      [request.rows[0]!.id, `AUD${RUN}`],
    );
    ticketId = ticket.rows[0]!.id;
    const blind = await client.query<{ id: string }>(
      `INSERT INTO waste_ticket_blind_checks (ticket_id, baseline_fingerprint)
       VALUES ($1, repeat('a', 64)) RETURNING id`,
      [ticketId],
    );
    blindCheckId = blind.rows[0]!.id;

    const observation = await client.query<{ id: string }>(
      `INSERT INTO waste_ticket_field_events
         (ticket_id, event, field, new_value, read_state, collection_version)
       VALUES ($1, 'recognized', 'volumeM3', '3', 'read', 2) RETURNING id`,
      [ticketId],
    );
    observationId = observation.rows[0]!.id;
  }, 120_000);

  afterAll(async () => {
    if (!client) return;
    await client.query(`DELETE FROM waste_requests WHERE comment = $1`, [`audit-${RUN}`]);
    await client.query(`DELETE FROM users WHERE email = $1`, [`audit-${RUN}@example.test`]);
    await client.query(`DELETE FROM construction_objects WHERE code = $1`, [`AUD-${RUN}`]);
    await client.end();
  });

  it('машинное чтение второй версии обязано сказать, прочитало ли оно поле', async () => {
    await rejectedBy(
      `INSERT INTO waste_ticket_field_events (ticket_id, event, field, new_value, collection_version)
       VALUES ($1, 'recognized', 'number', '26213', 2)`,
      [ticketId],
      'waste_ticket_field_events_v2_read_state_check',
    );
  });

  it('прежняя история первой версии проходит без признака прочтения', async () => {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO waste_ticket_field_events (ticket_id, event, field, new_value, collection_version)
       VALUES ($1, 'recognized', 'number', '26213', 1)`,
      [ticketId],
    );
    await client.query('ROLLBACK');
  });

  it('решение по предложению обязано помнить, отличалось ли поле', async () => {
    await rejectedBy(
      `INSERT INTO waste_ticket_field_events (ticket_id, event, field, new_value, collection_version)
       VALUES ($1, 'proposal', 'number', '26213', 2)`,
      [ticketId],
      'waste_ticket_field_events_v2_proposal_check',
    );
  });

  it('машинное чтение не бывает адресовано наблюдению: оно само наблюдение', async () => {
    await rejectedBy(
      `INSERT INTO waste_ticket_field_events
         (ticket_id, event, field, new_value, read_state, observation_id, collection_version)
       VALUES ($1, 'recognized', 'volumeM3', '38', 'read', $2, 2)`,
      [ticketId, observationId],
      'waste_ticket_field_events_observation_self_check',
    );
  });

  it('очистка поля правкой допустима: талон простоя объёма не несёт', async () => {
    // Ограничение 0206 требовало у правки непустого нового значения, и обычный ход разбора —
    // «вид работ: простой, объём стереть» — ронял запись события, откатывая вместе с ней саму
    // правку. Пустое «стало» законно; незаконно пустое с обеих сторон.
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO waste_ticket_field_events
         (ticket_id, event, field, old_value, new_value, observation_id, collection_version)
       VALUES ($1, 'edited', 'volumeM3', '20.000', NULL, $2, 2)`,
      [ticketId, observationId],
    );
    await client.query('ROLLBACK');
  });

  it('правка, пустая с обеих сторон, — строка ни о чём', async () => {
    await rejectedBy(
      `INSERT INTO waste_ticket_field_events
         (ticket_id, event, field, old_value, new_value, collection_version)
       VALUES ($1, 'edited', 'volumeM3', NULL, NULL, 2)`,
      [ticketId],
      'waste_ticket_field_events_edit_check',
    );
  });

  it('связь не может указать на наблюдение чужого поля', async () => {
    // Наблюдение — про объём; связь заведена про дату. Без составного ключа база пропустила бы:
    // «это чтение даты», показав на чтение объёма, и ошибка ушла бы не в тот столбец метрики.
    await rejectedBy(
      `INSERT INTO waste_ticket_blind_check_observations (blind_check_id, field, observation_id)
       VALUES ($1, 'issuedOn', $2)`,
      [blindCheckId, observationId],
      'waste_ticket_blind_check_observations_observation_fk',
    );
  });

  it('связь своего поля заводится', async () => {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO waste_ticket_blind_check_observations (blind_check_id, field, observation_id)
       VALUES ($1, 'volumeM3', $2)`,
      [blindCheckId, observationId],
    );
    await client.query('ROLLBACK');
  });

  it('наблюдение не удалить из-под адресованного ему решения', async () => {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO waste_ticket_field_events
         (ticket_id, event, field, old_value, new_value, observation_id, collection_version)
       VALUES ($1, 'edited', 'volumeM3', '3', '38', $2, 2)`,
      [ticketId, observationId],
    );
    try {
      await client.query(`DELETE FROM waste_ticket_field_events WHERE id = $1`, [observationId]);
      throw new Error('ожидался отказ RESTRICT, а удаление прошло');
    } catch (error) {
      expect(String((error as { constraint?: string }).constraint ?? error)).toContain(
        'waste_ticket_field_events_observation_id_fkey',
      );
    } finally {
      await client.query('ROLLBACK');
    }
  });

  it('наблюдение не удалить из-под связи', async () => {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO waste_ticket_blind_check_observations (blind_check_id, field, observation_id)
       VALUES ($1, 'volumeM3', $2)`,
      [blindCheckId, observationId],
    );
    try {
      await client.query(`DELETE FROM waste_ticket_field_events WHERE id = $1`, [observationId]);
      throw new Error('ожидался отказ RESTRICT, а удаление прошло');
    } catch (error) {
      expect(String((error as { constraint?: string }).constraint ?? error)).toContain(
        'waste_ticket_blind_check_observations_observation_fk',
      );
    } finally {
      await client.query('ROLLBACK');
    }
  });
});
