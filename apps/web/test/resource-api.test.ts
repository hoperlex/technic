import { describe, expect, it } from 'vitest';
import { json, mockHttp } from './http';
import {
  apiFetch,
  createGetApi,
  createListApi,
  createRemoveApi,
  createWriteApi,
} from '@shared/api';

/**
 * Фабрики ресурсов API. Сущность здесь синтетическая: фабрики лежат в shared и не знают ни заявок,
 * ни справочников — тест на доменных словах скрыл бы нарушение этой границы.
 *
 * Проверяется то, ради чего фабрики и заводились: запрос уходит тем же методом и на тот же путь,
 * что и написанный руками, а набор ручек у ресурса — ровно тот, который собрали. Второе важнее
 * первого: ошибка в пути видна сразу (404 на экране), а лишняя ручка компилируется, вызывается и
 * отвечает 404 только у того, кто до неё дошёл.
 */

interface SampleDto {
  id: string;
  name: string;
  isActive: boolean;
}

interface CreateSample {
  name: string;
}

interface UpdateSample {
  name?: string;
  isActive?: boolean;
}

const PATH = '/samples';

/** Ресурс со всеми умениями сразу — так его собрал бы слайс с полным набором ручек. */
const samplesApi = {
  ...createListApi<SampleDto>(PATH),
  ...createGetApi<SampleDto>(PATH),
  ...createWriteApi<SampleDto, CreateSample, UpdateSample>(PATH),
  ...createRemoveApi<{ ok: boolean }>(PATH),
};

const sample: SampleDto = { id: 's-1', name: 'Первый', isActive: true };

describe('фабрики ресурсов API', () => {
  it('список уходит GET на корень ресурса со всеми параметрами', async () => {
    const http = mockHttp({
      'GET /samples': () => json({ items: [sample], total: 1, page: 2, pageSize: 20 }),
    });

    const page = await samplesApi.list({ page: 2, search: 'абв' });

    expect(page.items).toEqual([sample]);
    expect(page.total).toBe(1);
    const call = http.lastCall('GET /samples');
    expect(call?.query.get('page')).toBe('2');
    expect(call?.query.get('search')).toBe('абв');
    expect(call?.body).toBeUndefined();
  });

  it('карточка уходит GET на путь с идентификатором', async () => {
    const http = mockHttp({
      'GET /samples/:id': ({ params }) => json({ ...sample, id: params.id }),
    });

    const result = await samplesApi.get('s-7');

    expect(result.id).toBe('s-7');
    expect(http.lastCall('GET /samples/:id')?.path).toBe('/samples/s-7');
  });

  it('заведение уходит POST телом на корень ресурса', async () => {
    const http = mockHttp({
      'POST /samples': ({ body }) => json({ ...sample, ...(body as object) }),
    });

    const created = await samplesApi.create({ name: 'Второй' });

    expect(created.name).toBe('Второй');
    expect(http.lastCall('POST /samples')?.body).toEqual({ name: 'Второй' });
  });

  it('правка уходит PATCH на путь с идентификатором', async () => {
    const http = mockHttp({
      'PATCH /samples/:id': ({ params, body }) =>
        json({ ...sample, id: params.id, ...(body as object) }),
    });

    const updated = await samplesApi.update('s-3', { isActive: false });

    expect(updated.isActive).toBe(false);
    const call = http.lastCall('PATCH /samples/:id');
    expect(call?.path).toBe('/samples/s-3');
    expect(call?.body).toEqual({ isActive: false });
  });

  it('удаление уходит DELETE без тела', async () => {
    const http = mockHttp({ 'DELETE /samples/:id': () => json({ ok: true }) });

    await expect(samplesApi.remove('s-1')).resolves.toEqual({ ok: true });
    expect(http.lastCall('DELETE /samples/:id')?.body).toBeUndefined();
  });

  it('ответ удаления отдаётся как есть: его форму задаёт ресурс, а не фабрика', async () => {
    // Ради этого у `createRemoveApi` и нет умолчания: у одного ресурса удаление отвечает `{ ok }`,
    // у другого — карточкой, уехавшей в архив. Фабрика ответ не разбирает и ничего в него не
    // домысливает.
    mockHttp({
      'DELETE /archived/:id': ({ params }) => json({ ...sample, id: params.id, isActive: false }),
    });
    const archivedApi = createRemoveApi<SampleDto>('/archived');

    await expect(archivedApi.remove('s-9')).resolves.toEqual({
      id: 's-9',
      name: 'Первый',
      isActive: false,
    });
  });

  describe('состав ресурса', () => {
    it('собранный ресурс несёт ровно те ручки, которые в него положили', () => {
      const readonlyApi = createListApi<SampleDto>(PATH);
      expect(Object.keys(readonlyApi)).toEqual(['list']);

      const withoutRemove = {
        ...createListApi<SampleDto>(PATH),
        ...createWriteApi<SampleDto, CreateSample, UpdateSample>(PATH),
      };
      expect(Object.keys(withoutRemove).sort()).toEqual(['create', 'list', 'update']);
      // Не косметика: ресурса без удаления в портале хватает — тип контейнера деактивируют
      // правкой. Ручка `remove`, выданная ему фабрикой «на всё сразу», компилировалась бы и
      // отвечала 404 уже на экране.
      expect('remove' in withoutRemove).toBe(false);
      expect('get' in withoutRemove).toBe(false);
    });

    it('полный набор — четыре умения и ничего сверх них', () => {
      expect(Object.keys(samplesApi).sort()).toEqual(['create', 'get', 'list', 'remove', 'update']);
    });

    it('нестандартная ручка остаётся написанной руками и живёт рядом с собранными', async () => {
      // Слова портала («вернуть из архива») фабрикам не отдаются: нижний слой их не знает. Слайс
      // дописывает такую ручку явно — расширение этому не мешает.
      const restorableApi = {
        ...createListApi<SampleDto>(PATH),
        restore: (id: string) => apiFetch<SampleDto>(`${PATH}/${id}/restore`, { method: 'POST' }),
      };
      const http = mockHttp({
        'POST /samples/:id/restore': ({ params }) => json({ ...sample, id: params.id }),
      });

      await restorableApi.restore('s-2');

      expect(http.lastCall('POST /samples/:id/restore')?.path).toBe('/samples/s-2/restore');
      expect(Object.keys(restorableApi).sort()).toEqual(['list', 'restore']);
    });
  });
});
