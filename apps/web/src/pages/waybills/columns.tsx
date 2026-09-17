import type { ReactNode } from 'react';
import { Button, Space, Tag, Tooltip, Typography } from 'antd';
import { StopOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import {
  canCancelWaybill,
  canCorrectWaybill,
  WAYBILL_CORRECTION_LOCKED_MESSAGE,
  WAYBILL_LOCKED_MESSAGE,
  type WaybillDto,
  waybillFormShortLabels,
  waybillStatusColors,
  waybillStatusLabels,
} from '@technic/contracts';
import { WaybillFilesCell } from '../../components/WaybillFiles';
import { EntityLink } from '@shared/ui';
import { actionsColumn, badgeColumn, textColumn } from '@shared/ui';
import { ExportWaybillButton, PrintWaybillButton } from '../../components/WaybillPrint';
import { useAuth } from '../../auth/AuthContext';
import { correctionHint, trimmedPrintHint } from './hints';
import { vehicleRequestViewLink, vehicleRouteLink } from '../../utils/links';

/**
 * Колонки журнала путевых листов.
 *
 * Своим файлом — рядом с фильтрами и подсказками журнала и по той же причине: страница отвечает за
 * отбор, запросы и окна, а колонка — за то, как читается одна графа бланка строгой отчётности.
 * Здесь это особенно заметно у последней колонки: доступность кнопок считается тремя правилами
 * контрактов (`canCancelWaybill`, `canCorrectWaybill` и глубина коррекции), и рядом с мутациями
 * страницы они читались как частности печати.
 */

/** Дата, которой меряются календарные границы листа; та же, что у страницы. */
const today = () => dayjs().format('YYYY-MM-DD');

/**
 * Имя начинается с `use`, потому что колонки спрашивают права (`useAuth`): ссылки на рейс и заявку
 * ведут туда, куда человеку открыто, и считать это за пределами хука нельзя.
 */
export interface WaybillColumnsDeps {
  canAttach: boolean;
  canCancel: boolean;
  canCorrect: boolean;
  canCorrectDeep: boolean;
  /** Номер связанного документа ссылкой: нажатие сужает журнал до него. */
  numberLink: (label: string, number: string) => ReactNode;
  onCancel: (waybill: WaybillDto) => void;
  openRequest: (requestId: string) => void;
  openRoute: (routeId: string) => void;
}

export function useWaybillJournalColumns({
  canAttach,
  canCancel,
  canCorrect,
  canCorrectDeep,
  numberLink,
  onCancel,
  openRequest,
  openRoute,
}: WaybillColumnsDeps) {
  const { can } = useAuth();
  return [
    textColumn<WaybillDto>({
      key: 'number',
      title: 'Номер',
      dataIndex: 'number',
      width: 240,
      // Поиск переехал в панель над таблицей: там его видно вместе с остальными сужениями.
      searchable: false,
      render: (_v, r) => (
        <Space orientation="vertical" size={0}>
          <span>{r.number}</span>
          {/* Метка стоит у номера, а не в столбце статуса: статус отвечает, действует ли бланк, а
            это — откуда он такой взялся. Признак считает сервер (`isCorrection`) по трём
            источникам, поэтому метку получает и списанный задним числом лист, у которого замены
            нет вовсе, и лист, которому закрытие заявки укоротило период. */}
          {r.isCorrection && (
            <Tooltip title={correctionHint(r)}>
              <Tag color="gold" style={{ marginInlineEnd: 0 }}>
                коррекция
              </Tag>
            </Tooltip>
          )}
          {r.correctsNumber && numberLink('заменил', r.correctsNumber)}
          {r.correctedByNumber && numberLink('заменён', r.correctedByNumber)}
        </Space>
      ),
    }),
    // Полная подпись бланка в колонку не влезает, а на вопрос «какой это лист» отвечает и
    // короткая. Отбор по бланку — в панели фильтров, там для полной подписи место есть.
    badgeColumn<WaybillDto>({
      key: 'formCode',
      title: 'Форма',
      dataIndex: 'formCode',
      width: 110,
      labels: waybillFormShortLabels,
      // Сортировки по бланку сервер не знает (`WAYBILL_SORT_FIELDS`), и заголовок не должен её
      // обещать: отправленное поле схема отклонит, а список ответит ошибкой вместо строк.
      // Отбирают по бланку фильтром в панели — этот вопрос и задают.
      sortable: false,
    }),
    textColumn<WaybillDto>({
      key: 'issuedForDate',
      title: 'На дату',
      dataIndex: 'issuedForDate',
      width: 150,
      // У ЭСМ-2 в этой графе не день, а неделя работ: лист выписан на период, и одна дата в нём
      // ничего не значит — по ней не понять, какую неделю держит бланк.
      render: (_v, r) =>
        r.periodFrom && r.periodTo
          ? `${dayjs(r.periodFrom).format('DD.MM')} — ${dayjs(r.periodTo).format('DD.MM.YYYY')}`
          : dayjs(r.issuedForDate).format('DD.MM.YYYY'),
    }),
    textColumn<WaybillDto>({
      key: 'vehicleLabel',
      title: 'Техника',
      dataIndex: 'vehicleLabel',
      sortable: false,
      searchable: false,
      render: (_v, r) => (
        <Space orientation="vertical" size={0}>
          <span>{r.vehicleLabel}</span>
          {r.withTrailer && (
            <Typography.Text type="secondary">с прицепом {r.trailerLabel}</Typography.Text>
          )}
        </Space>
      ),
    }),
    textColumn<WaybillDto>({
      key: 'driverName',
      title: 'Водитель',
      dataIndex: 'driverName',
      sortable: false,
      searchable: false,
      width: 220,
    }),
    /**
     * Рейс, по которому выдан бланк (ADR 0120).
     *
     * Место выбрано порядком чтения строки: «номер → бланк → дата → техника → водитель» отвечает,
     * какая бумага на кого выдана, и рейс замыкает эту связку — он и есть та поездка, ради которой
     * машину с человеком свели вместе. Дальше идут талоны заказчиков: чьи работы в этот рейс
     * попали.
     *
     * Номер открывает карточку рейса окном поверх журнала, а не уводит на его экран: вопрос «что
     * это была за поездка» задают, стоя в отобранном за месяц списке, и ответ на него не должен
     * стоить ни фильтров, ни обратной дороги. Ссылкой, а не кнопкой — Ctrl и средний щелчок
     * обязаны по-прежнему открывать рейс соседней вкладкой браузера (`EntityLink`).
     *
     * Пусто в этой графе — законное состояние, а не потеря данных, и потому показывается тем же
     * прочерком, что и журнал без талонов: у недельного ЭСМ-2 рейса нет по устройству бланка (он
     * держит неделю работы на площадке, а не поездку), и у листов, выданных до появления
     * маршрутов, его тоже нет.
     *
     * У механика и главного механика номер останется обычным текстом: журнал листов им положен, а
     * рейсы — нет (`vehicleRequests.status`), и `vehicleRouteLink` вернёт `null`. Это и есть
     * правильный ответ — назвать рейс и пустить в него не одно и то же.
     */
    textColumn<WaybillDto>({
      key: 'routeNumber',
      title: 'Маршрут',
      dataIndex: 'routeNumber',
      // Как у бланка и статуса: сортировки по рейсу сервер не знает (`WAYBILL_SORT_FIELDS`), а
      // поиск в журнале один — по номеру листа, полем в панели фильтров.
      sortable: false,
      searchable: false,
      width: 150,
      render: (_v, r) => {
        // Читают номер, а ведёт `routeId`: подпись рейса сервер собирает сам, а окно открывается
        // по идентификатору. Порознь эти два поля не приходят — но и рисовать ссылку в никуда,
        // случись это, нечем.
        const { routeId, routeNumber } = r;
        if (!routeId || !routeNumber) return <Typography.Text type="secondary">—</Typography.Text>;
        return (
          <EntityLink
            to={vehicleRouteLink(can, routeId)}
            title="Открыть маршрут"
            onActivate={() => openRoute(routeId)}
          >
            {routeNumber}
          </EntityLink>
        );
      },
    }),
    textColumn<WaybillDto>({
      key: 'requests',
      title: 'Талоны заказчиков',
      dataIndex: 'requests',
      sortable: false,
      searchable: false,
      width: 260,
      render: (_v, r) =>
        r.requests.length === 0 ? (
          <Typography.Text type="secondary">—</Typography.Text>
        ) : (
          <Space orientation="vertical" size={0}>
            {/* Номер талона ведёт к самой заявке: журнал отвечает, что за бланк выдан, а «что в
              нём за работа» спрашивают у заявки — и до сих пор искали её номер руками.

              Заявка открывается читалкой поверх журнала (ADR 0120), а не уводит на свою вкладку:
              уход стоил бы отбора, ради которого журнал и открыли, а делать из журнала ничего не
              нужно — работу по заявке ведут там, где её взяли. Адрес поэтому статус-независимый
              (`vehicleRequestViewLink`): вкладку выбирать не для чего, а `status` талона отвечает
              на другой вопрос. У механика обёртка вернёт `null` — `vehicleRequests.read` у него
              нет, и номер останется текстом, каким и был. */}
            {r.requests.map((link) => (
              <span key={link.requestId}>
                {link.slot}.{' '}
                <EntityLink
                  to={vehicleRequestViewLink(can, link.requestId)}
                  title="Открыть заявку"
                  onActivate={() => openRequest(link.requestId)}
                >
                  {link.displayNumber}
                </EntityLink>{' '}
                — {link.objectName}
              </span>
            ))}
          </Space>
        ),
    }),
    // Скан заполненного бланка: у ЭСМ-2 оборот заполняет заказчик, у 4-П — отметки о выполнении.
    // Портал этих значений не разбирает, но журнал обязан отвечать, чем кончился выданный номер.
    textColumn<WaybillDto>({
      key: 'files',
      title: 'Файлы',
      dataIndex: 'files',
      sortable: false,
      searchable: false,
      width: 100,
      render: (_v, r) => <WaybillFilesCell waybillId={r.id} files={r.files} canEdit={canAttach} />,
    }),
    badgeColumn<WaybillDto>({
      key: 'status',
      title: 'Статус',
      dataIndex: 'status',
      width: 130,
      labels: waybillStatusLabels,
      colors: waybillStatusColors,
      // Как и у бланка: сортировки по статусу сервер не знает, а сужают по нему фильтром.
      sortable: false,
    }),
    // Причина отдельной колонкой, а не подписью к статусу: аннулированный лист объясняют, и
    // читают это объяснение вместе с номером, а не вместо него.
    //
    // Колонка одна на два вопроса, потому что вопрос один — «почему этот номер такой»: у
    // списанного бланка отвечает `cancelReason` (туда же уходит причина коррекции, Р35), у
    // выписанного взамен — `correctionReason`. Второй столбец, пустой у всего журнала, кроме
    // коррекций, отнял бы место у талонов заказчиков ради той же фразы.
    textColumn<WaybillDto>({
      key: 'cancelReason',
      title: 'Причина',
      dataIndex: 'cancelReason',
      sortable: false,
      searchable: false,
      width: 200,
      ellipsis: true,
      render: (_v, r) => r.cancelReason || r.correctionReason || '',
    }),
    actionsColumn<WaybillDto>((r) => {
      /*
       * Две границы, а не одна (ADR 0101, Р20). До конца дня листа бланк списывает всякий, у кого
       * есть `waybills.cancel`, — это дневная работа. Дальше начинается коррекция: право
       * `waybills.correct`, глубина `waybills.correctBeyondLimit` и обязательная причина.
       *
       * Правила те же, что у сервера, и функции те же (`canCancelWaybill`, `canCorrectWaybill`):
       * кнопка не должна предлагать того, чем ручка ответит отказом, и не должна запирать того,
       * что ручка примет.
       */
      const today0 = today();
      const editable =
        r.status === 'issued' &&
        (canCancelWaybill(r, today0) ||
          (canCorrect && canCorrectWaybill(r, today0, { unlimited: canCorrectDeep })));
      const lockedTitle = canCorrect ? WAYBILL_CORRECTION_LOCKED_MESSAGE : WAYBILL_LOCKED_MESSAGE;
      return (
        <Space>
          {/* Печать первой — ради неё лист и открывают (ADR 0041), а файл забирают тогда, когда
            бланк дополняют от руки в редакторе таблиц. У аннулированного не работает ни то, ни
            другое: номер списан, а напечатанный бланк неотличим от действующего.

            Синяя точка в углу кнопки — «эта бумага уже уходила»: печатали или выгружали, кто
            угодно и когда угодно, в том числе пачкой.

            У сокращённого листа подсказка своя (Р13): второй экземпляр выйдет с укороченным
            периодом, и принять его за дубликат первого нельзя — иначе бухгалтерия увидит два
            разных бланка под одним номером и не будет знать, какой из них настоящий. */}
          <PrintWaybillButton
            waybillId={r.id}
            number={r.number}
            status={r.status}
            printedAt={r.printedAt}
            hint={trimmedPrintHint(r)}
          />
          <ExportWaybillButton
            waybillId={r.id}
            number={r.number}
            status={r.status}
            exportedAt={r.exportedAt}
          />
          {canCancel && (
            <Button
              size="small"
              danger
              icon={<StopOutlined />}
              disabled={!editable}
              // Причина запрета проговаривается подсказкой: выключенная кнопка без объяснения
              // читается как поломка.
              title={
                r.status === 'cancelled'
                  ? 'Лист уже аннулирован'
                  : !editable
                    ? lockedTitle
                    : canCancelWaybill(r, today0)
                      ? 'Аннулировать'
                      : 'Аннулировать задним числом: понадобится причина'
              }
              onClick={() => onCancel(r)}
            />
          )}
        </Space>
      );
    }),
  ];
}
