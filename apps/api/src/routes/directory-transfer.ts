import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  DIRECTORY_IMPORT_MAX_BYTES,
  directoryImportSchema,
  directoryKeySchema,
  directoryTitles,
  moscowDateKeyOf,
  type DirectoryInfoDto,
} from '@technic/contracts';
import { requirePrincipal } from '../auth/plugin';
import { writeAudit } from '../lib/audit';
import { err } from '../lib/errors';
import {
  countDirectory,
  DirectoryFileError,
  exportDirectory,
  importDirectory,
} from '../services/directory-transfer/engine';
import { directories, directoryFor } from '../services/directory-transfer/registry';

/**
 * Обмен справочниками через файл Excel (ADR 0073).
 *
 * Один маршрут на все справочники: какой именно выгружается, решает ключ в адресе, а что у него
 * за колонки — описание в реестре. Восемнадцать похожих маршрутов означали бы восемнадцать мест,
 * где по-разному ответят на ошибку разбора и по-разному запишут в журнал.
 */

const XLSX_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/** Файл в двести килобайт едет телом запроса; предел ставится с запасом на кодирование base64. */
const IMPORT_BODY_LIMIT = 8 * 1024 * 1024;

const keyParams = z.object({ key: directoryKeySchema });

export default async function directoryTransferRoutes(app: FastifyInstance): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const canExport = app.requirePermission('directories.export');
  const canImport = app.requirePermission('directories.import');

  /** Список справочников со счётчиками — им портал рисует вкладку обмена. */
  r.get('/', { preHandler: [app.authenticate, canExport] }, async () => {
    const items: DirectoryInfoDto[] = await Promise.all(
      directories.map(async (def) => ({
        key: def.key,
        title: directoryTitles[def.key],
        count: await countDirectory(def),
      })),
    );
    return { items };
  });

  r.get(
    '/:key/export',
    { preHandler: [app.authenticate, canExport], schema: { params: keyParams } },
    async (req, reply) => {
      const def = directoryFor(req.params.key);
      if (!def) throw err.notFound('Справочник не участвует в обмене');
      const { bytes, rows } = await exportDirectory(def);

      // Выгрузка уносит из портала справочник целиком — у водителей вместе с ФИО и СНИЛС.
      // Это учётное событие того же порядка, что выгрузка путевого листа, и пишется всегда.
      await writeAudit({
        actorUserId: requirePrincipal(req).id,
        action: 'directory.export',
        entityType: 'directory',
        metadata: { directory: def.key, rows },
      });

      const name = `${directoryTitles[def.key]} ${moscowDateKeyOf(new Date())}.xlsx`;
      return reply
        .type(XLSX_TYPE)
        .header('content-disposition', `attachment; filename*=UTF-8''${encodeURIComponent(name)}`)
        .send(Buffer.from(bytes));
    },
  );

  r.post(
    '/:key/import',
    {
      preHandler: [app.authenticate, canImport],
      bodyLimit: IMPORT_BODY_LIMIT,
      schema: { params: keyParams, body: directoryImportSchema },
    },
    async (req) => {
      const p = requirePrincipal(req);
      const def = directoryFor(req.params.key);
      if (!def) throw err.notFound('Справочник не участвует в обмене');

      const bytes = Buffer.from(req.body.contentBase64, 'base64');
      if (bytes.byteLength === 0) throw err.unprocessable('Файл пуст');
      if (bytes.byteLength > DIRECTORY_IMPORT_MAX_BYTES) {
        throw err.unprocessable(
          `Файл больше ${Math.round(DIRECTORY_IMPORT_MAX_BYTES / (1024 * 1024))} МБ. Справочник столько не весит — проверьте, тот ли это файл.`,
        );
      }

      let report;
      try {
        report = await importDirectory(def, bytes, {
          dryRun: req.body.dryRun,
          actorUserId: p.id,
        });
      } catch (e) {
        // Разбор упал — это про содержимое присланного файла, и сказать надо дословно: «строка 14:
        // вид ТС «spec» не найден» человек исправит сам, а 422 без текста вернёт его к тому, у
        // кого есть доступ к логам (ADR 0047 п. 6).
        if (e instanceof DirectoryFileError) throw err.unprocessable(e.message);
        throw e;
      }

      // Пишется только состоявшаяся загрузка: предпросмотр базу не менял. Состава строк в журнале
      // нет — заведённые записи видны в самом справочнике, а у водителей это были бы ФИО.
      if (!req.body.dryRun) {
        await writeAudit({
          actorUserId: p.id,
          action: 'directory.import',
          entityType: 'directory',
          metadata: {
            directory: def.key,
            filename: req.body.filename,
            created: report.created.length,
            updated: report.updated.length,
            unchanged: report.unchanged,
          },
        });
      }
      return report;
    },
  );
}
