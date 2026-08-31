import { useEffect, useState } from 'react';
import { Empty, Pagination, Segmented, Skeleton, Space, Typography } from 'antd';
import { useQuery } from '@tanstack/react-query';
import type {
  OfficeEquipmentConsumableDto,
  OfficeEquipmentConsumableStockEntryKind,
} from '@technic/contracts';
import { ViewModal } from '@shared/ui';
import { useIsMobile } from '@shared/lib';
import {
  officeEquipmentConsumableKeys,
  officeEquipmentConsumablesApi,
} from '@entities/office-equipment';
import { OfficeEquipmentStockJournal } from './OfficeEquipmentStockJournal';

/**
 * История остатка одной позиции — своим окном (план
 * `docs/office-equipment-consumables-and-purchase-plan.md`, Р4).
 *
 * ПОЧЕМУ ОКНО, А НЕ СЕКЦИЯ КАРТОЧКИ. До Р4 лента ехала в ответе `GET /:id` и лежала под формой
 * правки. Дело не в тесноте: карточка открывается на правку только у ведущего номенклатуру, а
 * вопрос «куда делись картриджи» задаёт и кладовщик, и тот, кто просто смотрит перечень. Лента
 * уехала в действие строки, а из карточки убрана совсем — два места для одного журнала разошлись
 * бы на первой же правке, начиная с отбора по виду события, которого у карточки не было бы.
 *
 * ОКНО ВСЕГДА ПРО ОДНУ ПОЗИЦИЮ, общего журнала нет вовсе (прямая просьба заказчика) — отсюда и
 * заголовок наименованием с кодом: код первым спрашивают у поставщика, наименованием позицию
 * узнают глазами, и оба нужны, чтобы человек видел, чей журнал он читает.
 *
 * СТРАНИЦЫ БЕРЁТ СЕРВЕР, И ПОРЯДОК ТОЖЕ. Лента упорядочена по `seq` вниз (а не по времени: две
 * правки одной секунды по `createdAt` неразличимы), и портал строки не пересортировывает — иначе
 * страница, собранная сервером, читалась бы в чужом порядке на каждом стыке.
 *
 * Права своего у журнала нет: он открыт всякому, кому открыт сам перечень. Лента не показывает
 * ничего, чего не показывала бы позиция, — те же события, те же имена, те же номера заявок, — и
 * второе право означало бы «число видишь, а откуда оно взялось — нет». Единственное, что в ней
 * считается по смотрящему, — можно ли открыть заявку (`requestAccessible`), и считает это сервер.
 */

interface Props {
  /** Позиция, чей журнал читают; `null` — окно закрыто. */
  consumable: OfficeEquipmentConsumableDto | null;
  onClose: () => void;
}

/**
 * Размер страницы. Пятьдесят — не «на глаз», а наименьшее из общего перечня портала
 * (`PAGE_SIZES` контракта): свои числа схема ленты не принимает, а просить больше незачем — ленту
 * читают сверху, с последних событий.
 */
const PAGE_SIZE = 50;

/** Первая страница: с неё окно открывается и на неё же возвращается при смене отбора. */
const FIRST_PAGE = 1;

/** «Все» — отдельным значением отбора, а не отсутствующим: у переключателя не бывает пустоты. */
type KindFilter = OfficeEquipmentConsumableStockEntryKind | 'all';

/**
 * Отбор по виду события (Р4). Чаще ленту читают целиком — она и заведена ради связного рассказа,
 * — поэтому «Все» стоит первым и выбрано по умолчанию; отбор нужен, когда ищут конкретное («кто
 * выдавал этот картридж», «когда мы сами пересчитывали полку»).
 */
const KIND_OPTIONS: { value: KindFilter; label: string }[] = [
  { value: 'all', label: 'Все' },
  { value: 'manual', label: 'Ручные правки' },
  { value: 'issue', label: 'Выдачи' },
  { value: 'return', label: 'Возвраты' },
];

/**
 * Подпись про автора. Обязательная, а не поясняющая: роль и наборы полномочий приходят
 * СЕГОДНЯШНИЕ (решение заказчика — историю роли и выдач портал не хранит), и без этих слов подпись
 * «Иванов И. И. · Штаб · Оргтехника: ведение» читается как снимок марта, когда событие и
 * записывали.
 */
const SIGNATURE_NOTE =
  'Роль и наборы полномочий у подписи показаны сегодняшние: кем человек был на момент события, портал не хранит.';

/** Пусто по отбору и пусто вообще — разные новости, и путать их нельзя. */
function emptyTextOf(kind: KindFilter): string {
  return kind === 'all'
    ? 'Остаток ещё не меняли: движения по этой позиции не было ни разу'
    : 'По этому виду событий записей нет — посмотрите ленту целиком';
}

export function OfficeEquipmentStockHistoryModal({ consumable, onClose }: Props) {
  const isMobile = useIsMobile();
  const [kind, setKind] = useState<KindFilter>('all');
  const [page, setPage] = useState(FIRST_PAGE);

  const openedId = consumable?.id;
  useEffect(() => {
    // Окно открывают и на соседней строке: седьмая страница чужого журнала и отбор прошлого
    // захода к ней отношения не имеют — и седьмой страницы у неё может не быть вовсе.
    setKind('all');
    setPage(FIRST_PAGE);
  }, [openedId]);

  /*
   * Отбор уходит в запрос отсутствием поля, а не значением «все»: так его и читает схема ленты, и
   * лишнее значение перечисления пришлось бы заводить на сервере ради одного переключателя.
   */
  const query = {
    page,
    pageSize: PAGE_SIZE,
    ...(kind === 'all' ? {} : { entryKind: kind }),
  };

  const { data, isFetching } = useQuery({
    queryKey: officeEquipmentConsumableKeys.stockEntries(openedId ?? '', query),
    queryFn: () => officeEquipmentConsumablesApi.stockEntries(openedId!, query),
    // Журнал спрашивают, только когда его открыли: ради кнопки в строке перечня ленту не тянут.
    enabled: !!openedId,
  });

  const entries = data?.items ?? [];

  return (
    <ViewModal
      // Наименование и код: окно всегда про одну позицию, и чей это журнал, должно читаться из
      // заголовка, а не угадываться по строкам ленты.
      title={consumable ? `История остатка: ${consumable.name} · ${consumable.code}` : ''}
      open={!!consumable}
      onClose={onClose}
      width={720}
      // Следующий раз журнал открывают у другой позиции: пересобрать тело дешевле, чем показать
      // на мгновение чужие строки, пока не пришёл ответ.
      destroyOnHidden
      bodyStyle={{
        ...(isMobile ? { height: '100%' } : { height: '60vh' }),
        display: 'flex',
        flexDirection: 'column',
        gap: 12,
        overflow: 'hidden',
      }}
    >
      <Space size={[12, 8]} wrap style={{ flex: '0 0 auto' }}>
        <Segmented<KindFilter>
          value={kind}
          options={KIND_OPTIONS}
          onChange={(v) => {
            setKind(v);
            // Отбор сужает ленту, и страница из прошлого отбора уехала бы за её край: человек
            // нажал «Выдачи» и увидел бы пустоту там, где выдачи есть.
            setPage(FIRST_PAGE);
          }}
        />
      </Space>

      {/* Подпись видна всегда, а не подсказкой по наведению: на телефоне наводить нечем, а
          прочитать «сегодняшние» нужно именно тому, кто разбирает событие прошлой весны. */}
      <Typography.Text type="secondary" style={{ flex: '0 0 auto', fontSize: 12 }}>
        {SIGNATURE_NOTE}
      </Typography.Text>

      <div style={{ flex: '1 1 auto', minHeight: 0, overflowY: 'auto' }}>
        {isFetching && !data ? (
          <Skeleton active paragraph={{ rows: 6 }} />
        ) : entries.length === 0 ? (
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={emptyTextOf(kind)} />
        ) : (
          <OfficeEquipmentStockJournal entries={entries} />
        )}
      </div>

      {/*
       * Постраничность — по ответу сервера, а не по состоянию экрана: он один знает, сколько
       * строк отдал и сколько их всего по этому отбору.
       *
       * Размер страницы не переключается: ленту читают сверху, с последних событий, а кому нужен
       * весь расход целиком, тот берёт отчёт за период — он и собран для этого вопроса.
       */}
      {data && data.total > PAGE_SIZE && (
        <Pagination
          align="end"
          style={{ flex: '0 0 auto' }}
          simple={isMobile}
          size={isMobile ? 'small' : undefined}
          current={data.page}
          pageSize={data.pageSize}
          total={data.total}
          showSizeChanger={false}
          showTotal={(total, range) => `${range[0]}–${range[1]} из ${total} событий`}
          onChange={setPage}
        />
      )}
    </ViewModal>
  );
}
