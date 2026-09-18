import { useState, type ReactNode } from 'react';
import { App, Button, Empty, Space, Spin, Table, Tag, Typography } from 'antd';
import type { TableColumnsType } from 'antd';
import { useInfiniteQuery } from '@tanstack/react-query';
import {
  deviceMessageStatusLabels,
  DEVICE_TELEMETRY_PAGE_SIZE,
  deviceIdentityLabels,
  type DeviceMailQueueItemDto,
} from '@technic/contracts';
import { deviceMailApi, deviceMailKeys } from '@entities/device-mail';
import {
  DeviceMailBindModal,
  MailboxStateBar,
  useDeviceMailIgnore,
  useDeviceMailReparse,
  useDeviceMailReviewed,
} from '@features/device-mail-review';
import { PageTableLayout } from '@shared/ui';
import { formatDateTime } from '../../utils/format';

/**
 * ОЧЕРЕДЬ «ПИСЬМА УСТРОЙСТВ» — режим внутри вкладки «Техника» (план
 * `docs/office-equipment-mail-telemetry-plan.md`, §10).
 *
 * РЕЖИМОМ, А НЕ ВКЛАДКОЙ РАЗДЕЛА, и образец тому — разбор кандидатов (`CandidatesTab.tsx`,
 * переключатель `Segmented` в `EquipmentTab.tsx`). Причина та же: очередь отвечает на тот же
 * вопрос, что и парк, — «что у нас за техника», — только про письма, которые пока ничьи. Разбирая
 * их, человек тут же смотрит в парк: «а есть ли вообще такой серийник». Отдельная вкладка развела
 * бы по двум входам одну работу.
 *
 * ПОРЯДОК — СТАРЫЕ СВЕРХУ. У остальных списков модуля вопрос «что нового», здесь — «чья очередь»:
 * свежее сверху означало бы, что письмо, до которого не дошли руки в первый день, не дождётся
 * разбора никогда. Листается курсором, а не страницами: очередь пополняется приёмником прямо во
 * время разбора, и нумерованные страницы при вставке в середину теряли бы строки молча.
 *
 * ШАПКА СОСТОЯНИЯ ЯЩИКОВ — НЕ УКРАШЕНИЕ. Письмо может застрять, не дойдя до базы вовсе (§9.1,
 * п. 8): тело не принято ни разу, строки нет, очередь честно пуста. Без шапки мёртвый приём
 * выглядит ровно как разобранный ящик.
 *
 * ЧЕТЫРЕ ДЕЙСТВИЯ, И ОДНО ВИДНО НЕ ВСЕГДА. «Перечитать» показывается ТОЛЬКО при `rawState ===
 * 'stored'`: у письма сверх потолка тела не было вовсе, у старого оно вычищено по сроку хранения, и
 * падающая кнопка без объяснения хуже отсутствующей.
 *
 * «ИГНОРИРОВАТЬ» И «ПРОСМОТРЕНО» — РАЗНЫЕ ДЕЙСТВИЯ, И ПУТАТЬ ИХ ДОРОГО. Первое отбрасывает письмо:
 * меняет СТАТУС, и потому выводит его и из очереди, и из отбора пачки (`apply.ts` отбирает по
 * статусу). Второе — только закрывающий след, и он законен ровно там, где другого выхода у письма
 * нет (`stuck`, вычищенное сырьё): письмо, ждущее привязки, такая отметка не решила бы, а потеряла.
 *
 * ДОСТУПНОСТЬ ОТМЕТКИ ЭКРАН НЕ СЧИТАЕТ — она приходит ФЛАГОМ `canReview`, как и у соседнего
 * действия `canReparse`. Считает её сервер тем же предикатом, которым и стережёт ручку, поэтому
 * спрятанная кнопка и отказ ручки не могут разойтись: копия правила на этой стороне расходилась бы
 * молча (AGENTS.md, «правило одного места»). Барьер в ручке при этом никуда не делся — он нужен
 * против прямого запроса и против страницы, открытой полчаса назад.
 *
 * ОБА НЕОБРАТИМЫХ ДЕЙСТВИЯ СПРАШИВАЮТ ПОДТВЕРЖДЕНИЕ. Отменить их нечем: списка отброшенных и
 * просмотренных в портале нет, обратной ручки тоже, — а стоят они рядом с «Привязать» в одной
 * строке таблицы, где промах мышью стоит письма.
 */
export function DeviceMailReview({ toolbar }: { toolbar?: ReactNode }) {
  const { modal } = App.useApp();
  const [binding, setBinding] = useState<DeviceMailQueueItemDto | null>(null);
  const reviewed = useDeviceMailReviewed();
  const reparse = useDeviceMailReparse();
  const ignore = useDeviceMailIgnore();
  /*
   * Кто именно в работе — идентификатором строки, а не общим `isPending`. Общий признак крутил бы
   * кнопки во ВСЕХ строках сразу: человек, нажавший «Перечитать» у одного письма, читал бы это как
   * «портал делает что-то со всей очередью», и — хуже — не понял бы, какая строка отработала.
   *
   * Нужен он ровно «Перечитать»: два необратимых действия идут через окно подтверждения, и ожидание
   * показывает само окно — своя крутилка под ним была бы вторым признаком одной работы.
   */
  const [busyId, setBusyId] = useState<string | null>(null);
  const runOn = (id: string, run: (value: string) => Promise<unknown>) => {
    setBusyId(id);
    void run(id)
      // Отказ уже объяснён сообщением самой мутации; здесь он гасится, чтобы не остаться
      // необработанным обещанием — на это прогон падает отдельно от смысла проверки.
      .catch(() => undefined)
      .finally(() => setBusyId((current) => (current === id ? null : current)));
  };

  const { data, isLoading, fetchNextPage, hasNextPage, isFetchingNextPage } = useInfiniteQuery({
    queryKey: deviceMailKeys.queue(DEVICE_TELEMETRY_PAGE_SIZE),
    queryFn: ({ pageParam }) =>
      deviceMailApi.queue(
        pageParam
          ? { cursor: pageParam, pageSize: DEVICE_TELEMETRY_PAGE_SIZE }
          : { pageSize: DEVICE_TELEMETRY_PAGE_SIZE },
      ),
    initialPageParam: '',
    // `nextCursor: null` — дальше ничего нет; `undefined` для react-query значит то же самое.
    getNextPageParam: (last) => last.items.nextCursor ?? undefined,
  });

  const pages = data?.pages ?? [];
  /*
   * Состояние ящиков берётся из ПЕРВОЙ страницы, а не из последней: каждая догруженная страница
   * несёт свежий снимок заодно (так устроен `DeviceMailQueueDto`), и подмена шапки на середине
   * листания читалась бы как событие в приёмнике, которого не было.
   */
  const mailbox = pages[0]?.mailbox ?? [];
  const items = pages.flatMap((page) => page.items.items);

  const columns: TableColumnsType<DeviceMailQueueItemDto> = [
    {
      title: 'Принято',
      dataIndex: 'receivedAt',
      width: 150,
      // Приём портала, а не время аппарата: очередь упорядочена им, и подпись обязана совпадать с
      // порядком. Время аппарата у письма справочное и живёт в карточке строки.
      render: (_: string, row) => formatDateTime(row.receivedAt),
    },
    {
      title: 'Письмо',
      dataIndex: 'subject',
      render: (_: string, row) => (
        <>
          <div>{row.subject || 'без темы'}</div>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {row.fromAddress || 'отправитель не указан'}
          </Typography.Text>
        </>
      ),
    },
    {
      title: 'Что видно',
      dataIndex: 'identity',
      render: (_: unknown, row) => <IdentityHints item={row} />,
    },
    {
      title: 'Состояние',
      dataIndex: 'status',
      width: 230,
      render: (_: string, row) => (
        <>
          <Tag>{deviceMessageStatusLabels[row.status]}</Tag>
          {row.errorText ? (
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {row.errorText}
            </Typography.Text>
          ) : null}
        </>
      ),
    },
    {
      title: 'Ждёт применения',
      dataIndex: 'observationCount',
      width: 140,
      // Числа снимка, а не записанных строк: наблюдения и события ложатся в карточку только при
      // однозначной привязке (Р20), и до неё это ровно «сколько приедет, если привязать».
      render: (_: number, row) => `${row.observationCount} / ${row.eventCount}`,
    },
    {
      title: '',
      dataIndex: 'id',
      width: 320,
      render: (_: string, row) => (
        <Space size={4} wrap>
          <Button size="small" type="link" onClick={() => setBinding(row)}>
            Привязать
          </Button>
          {row.canReparse ? (
            <Button
              size="small"
              type="link"
              loading={busyId === row.id && reparse.isPending}
              onClick={() => runOn(row.id, reparse.mutateAsync)}
            >
              Перечитать
            </Button>
          ) : null}
          <Button
            size="small"
            type="link"
            danger
            onClick={() =>
              modal.confirm({
                title: 'Отбросить письмо?',
                // Подтверждение называет ПОСЛЕДСТВИЕ, а не переспрашивает «вы уверены»: показания
                // этого письма не попадут в карточку никогда, а вернуть его из отброшенных нечем.
                content:
                  'Письмо уйдёт из очереди, и его показания в карточку не попадут. ' +
                  'Вернуть отброшенное письмо в очередь нельзя.',
                okText: 'Отбросить',
                okButtonProps: { danger: true },
                cancelText: 'Отмена',
                onOk: () => ignore.mutateAsync(row.id),
              })
            }
          >
            Игнорировать
          </Button>
          {row.canReview ? (
            <Button
              size="small"
              type="link"
              onClick={() =>
                modal.confirm({
                  title: 'Отметить просмотренным?',
                  // Подтверждение называет ПОСЛЕДСТВИЕ: строка уходит из очереди навсегда —
                  // списка просмотренных в портале нет, и обратной ручки тоже.
                  content:
                    'Строка уйдёт из очереди навсегда: списка просмотренных нет, ' +
                    'и вернуть её в очередь нельзя.',
                  okText: 'Отметить',
                  cancelText: 'Отмена',
                  onOk: () => reviewed.mutateAsync(row.id),
                })
              }
            >
              Просмотрено
            </Button>
          ) : null}
        </Space>
      ),
    },
  ];

  return (
    <>
      <PageTableLayout toolbar={toolbar}>
        <MailboxStateBar mailbox={mailbox} />
        {isLoading ? (
          <Spin size="small" />
        ) : items.length === 0 ? (
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={QUEUE_EMPTY_TEXT} />
        ) : (
          <>
            <Table<DeviceMailQueueItemDto>
              size="small"
              rowKey="id"
              columns={columns}
              dataSource={items}
              pagination={false}
            />
            {hasNextPage ? (
              <Button
                type="link"
                loading={isFetchingNextPage}
                onClick={() => void fetchNextPage()}
                style={{ marginTop: 8 }}
              >
                Показать ещё
              </Button>
            ) : null}
          </>
        )}
      </PageTableLayout>

      <DeviceMailBindModal item={binding} onClose={() => setBinding(null)} />
    </>
  );
}

/**
 * «Разобрано всё», а не «данных нет». Разница несущая: пустая очередь — это норма и цель работы, а
 * «данных нет» человек читает как поломку и идёт проверять приёмник. Про самого приёмника отвечает
 * шапка ящиков, и она стоит выше этой строки именно поэтому.
 */
export const QUEUE_EMPTY_TEXT = 'Непривязанных писем нет — всё разобрано';

/**
 * Подсказки опознания в строке очереди: серийник, инвентарный, имя устройства, сетевое имя и IP.
 *
 * ПОКАЗЫВАЮТСЯ ТОМУ, КТО БУДЕТ ПРИВЯЗЫВАТЬ, и в этом весь смысл столбца: по ним человек и узнаёт
 * аппарат. IP среди них стоит с оговоркой — ключом он не бывает никогда (§6, после DHCP по старому
 * адресу стоит другой принтер), но глазами по нему узнают («это тот, что в 214-м»).
 *
 * Ни одной подсказки — так и сказано словами: у переростка и битого конверта снимка нет вовсе, и
 * пустая ячейка выглядела бы потерянной разметкой.
 */
function IdentityHints({ item }: { item: DeviceMailQueueItemDto }) {
  const rows: [string, string][] = [];
  if (item.identity.serial) rows.push([deviceIdentityLabels.serial, item.identity.serial]);
  if (item.identity.inventory) rows.push([deviceIdentityLabels.inventory, item.identity.inventory]);
  if (item.identity.deviceName) {
    rows.push([deviceIdentityLabels.deviceName, item.identity.deviceName]);
  }
  if (item.identity.host) rows.push([deviceIdentityLabels.host, item.identity.host]);
  if (item.identity.ip) rows.push(['IP', item.identity.ip]);
  if (item.identity.model) rows.push(['Модель', item.identity.model]);
  if (rows.length === 0) {
    return <Typography.Text type="secondary">{NO_HINTS_TEXT}</Typography.Text>;
  }
  return (
    <>
      {rows.map(([label, value]) => (
        <div key={label} style={{ fontSize: 12 }}>
          <Typography.Text type="secondary">{label}: </Typography.Text>
          {value}
        </div>
      ))}
    </>
  );
}

/** Письмо не назвало себя ничем: опознавать придётся по теме и отправителю. */
export const NO_HINTS_TEXT = 'Аппарат себя не назвал';
