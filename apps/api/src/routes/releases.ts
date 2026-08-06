import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { desc } from 'drizzle-orm';
import { type ReleaseDto, releaseItemsSchema } from '@technic/contracts';
import { db } from '../db/client';
import { appReleases } from '../db/schema';

/**
 * Журнал обновлений портала (ADR 0077): что и когда появилось, словами того, кто в портале
 * работает. Читает, а не пишет: выпуски заводит миграция, экрана редактирования нет.
 *
 * Права нет намеренно, только `authenticate` (ADR 0077 §5). Персональных данных в журнале нет, а
 * право, закрывающее «что нового в портале», пришлось бы выдавать всем — то есть оно не различало
 * бы никого. Пункт меню стоит рядом с «Техподдержкой» и по той же причине: это служебное окно, а
 * не раздел портала.
 *
 * Номера ADR наружу не идут: пользователю нужен вес выпуска, а сами номера — внутренняя ссылка на
 * `docs/adr`. Поэтому в ответе `adrCount`, а не массив.
 */

/**
 * Последние двадцать: журнал открывают вопросом «что нового», а не «что было весной». Страницы у
 * ручки нет — выпусков за год набегает несколько десятков, и листалка обслуживала бы прокрутку
 * одного окна.
 */
const RECENT_LIMIT = 20;

export default async function releasesRoutes(app: FastifyInstance): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.get('/', { preHandler: [app.authenticate] }, async (): Promise<ReleaseDto[]> => {
    const rows = await db
      .select({
        seq: appReleases.seq,
        version: appReleases.version,
        releasedOn: appReleases.releasedOn,
        title: appReleases.title,
        adrs: appReleases.adrs,
        items: appReleases.items,
      })
      .from(appReleases)
      // Только по `seq`: дата выпуски не упорядочивает — несколько блоков доезжают в один день.
      .orderBy(desc(appReleases.seq))
      .limit(RECENT_LIMIT);

    return rows.map((row) => ({
      seq: row.seq,
      version: row.version,
      releasedOn: row.releasedOn,
      title: row.title,
      adrCount: row.adrs.length,
      // Разбор здесь, а не в БД: `items` набраны руками в миграции, и схема из контрактов —
      // единственное место, где содержимое jsonb становится пунктами выпуска.
      items: releaseItemsSchema.parse(row.items),
    }));
  });
}
