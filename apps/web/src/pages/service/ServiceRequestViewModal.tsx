import { useMemo, useState, type ReactNode } from 'react';
import { Badge, Button, Space, Spin, Tabs, Typography } from 'antd';
import { MessageOutlined, PlayCircleOutlined, ProfileOutlined } from '@ant-design/icons';
import { useQuery } from '@tanstack/react-query';
import {
  type RequestHistoryEntryDto,
  type ServiceRequestDto,
  serviceRequestChangeLabels,
  serviceRequestStatusColors,
  serviceRequestStatusLabels,
} from '@technic/contracts';
import {
  ServiceConsumablesTable,
  serviceRequestKeys,
  serviceRequestsApi,
} from '@entities/service-request';
import { ActionMenuButton, ActionSheet, ViewFields, ViewModal } from '@shared/ui';
import type { ServiceMenuItem } from './serviceStatusChoices';
import { useIsMobile } from '@shared/lib';
import { useAuth } from '../../auth/AuthContext';
import { type HistoryRow, RequestHistoryTable } from '../../components/RequestHistory';
import { ServiceRequestDocuments } from './ServiceRequestDocuments';
import { ServiceRequestEstimate } from './ServiceRequestEstimate';
import { cardMenuItems } from './serviceMenuPlacement';
import { serviceRequestViewFields } from './serviceRequestViewFields';

/**
 * События истории для общей таблицы (ADR 0012).
 *
 * Переход дублируется строкой под событием, хотя слева от него и так стоят баблы статусов. Причина
 * в том, что баблы общей таблицы подписаны словарём статусов «Вывоза мусора» и «Заказа ТС», а у
 * этого модуля статусы свои (ADR 0085 §5): «Диагностика» и «Назначена» в том словаре не значатся, и
 * бабл остался бы пустым. Пока подписи не станут модульными, читателю истории важнее увидеть
 * переход словами, чем ровную раскладку.
 *
 * Причину отмены читают именно здесь (Р12): в карточке её нет вовсе — она уходит комментарием
 * перехода, и «не согласовано» объясняется этой лентой, а решение стоит полем на вкладке «Заявка».
 */
function toRows(history: RequestHistoryEntryDto[] | undefined): HistoryRow[] {
  return (history ?? []).map((e) => ({ key: e.id, entry: e }));
}

/**
 * Подписи и цвета статусов этого модуля для истории: цикл у него свой (ADR 0085), и общий словарь
 * заявок его статусов не знает — без этого переход подписывался бы чужими словами.
 */
const SERVICE_HISTORY_STATUSES = {
  labels: serviceRequestStatusLabels as Record<string, string>,
  colors: serviceRequestStatusColors as Record<string, string>,
};

/**
 * Карточка заявки на обслуживание (§9.4): вкладки «Заявка», «Объём работ», «Документы», «История».
 * Средняя из них зависит от заявки и от читателя: у расходников на её месте «Номенклатура», а
 * заявителю (ADR 0160) её нет вовсе — вкладок остаётся три.
 *
 * Вкладками, а не одной длинной страницей: у заявки три стороны и три разных разговора — что
 * сломалось, во сколько это встало и чем подтверждено. В один свиток они складываются так, что
 * объём работ приходится искать прокруткой между фотографиями и историей.
 *
 * Ход заявки карточка не решает сама: набор действий ей строит коридор переходов
 * (`useServiceRequestActions`) — тот же, что и строке списка. Но открываются они отсюда, и потому
 * окна действий карточки живут внутри неё (ADR 0140): снаружи они делят слой с самой карточкой и
 * прячутся под ней. Исполнители — единственное действие, вынесенное из меню в тело: состав правят
 * там же, где его читают.
 */
export function ServiceRequestViewModal({
  request: row,
  onClose,
  actions,
  pendingId,
  modals,
}: {
  /** `null` — окно закрыто. Строка списка: с неё карточка рисуется, пока едет свежая. */
  request: ServiceRequestDto | null;
  onClose: () => void;
  /**
   * Ход заявки: набор строит `useServiceRequestActions` — коридором там, где действие ещё переход,
   * и предикатами Р11 там, где оно им быть перестало. Не передан — карточка только на чтение
   * (архив). Действия стоят в подвале, потому что решают, прочитав объём работ и историю, — то есть
   * здесь, а не в строке списка.
   */
  actions?: (request: ServiceRequestDto) => ServiceMenuItem[];
  /**
   * Заявка, по которой идёт действие без окна (ADR 0161): её тег статуса ждёт ответа. Приходит
   * снаружи, из того же набора, чьи окна карточка держит внутри себя (ADR 0140).
   */
  pendingId?: string | null;
  /**
   * Окна действий карточки (ADR 0140). Рендерятся **внутри** окна, и это не вкусовщина:
   * вложенная модалка получает от antd собственный слой (`ZIndexContext` даёт ей z-index на сотню
   * выше родительской), а соседняя по странице делит слой с карточкой — у корневых модалок
   * z-index один на всех, и спор решает порядок узлов в `body`. Карточка же пересоздаёт свой узел
   * при каждом открытии (`destroyOnHidden`), поэтому рано или поздно оказывается последней и
   * накрывает окно действия: человек нажимает пункт меню и видит, что «ничего не произошло».
   *
   * Отсюда и раздельное владение: набор окон для строк списка живёт на уровне страницы, набор
   * окон карточки — здесь. Один и тот же отрисовать в двух местах нельзя — это два экземпляра
   * одного окна.
   */
  modals?: ReactNode;
}) {
  const { user } = useAuth();
  const isMobile = useIsMobile();
  const [sheetOpen, setSheetOpen] = useState(false);

  /**
   * Карточка спрашивает заявку сама, а не довольствуется строкой списка: подшитый документ и
   * согласованный объём работ должны появляться в открытом окне, а строка в списке к этому моменту
   * уже устарела. Строка при этом показывается сразу (`placeholderData`) — ждать ответа, чтобы
   * показать то, что и так есть, незачем.
   */
  const { data: fresh } = useQuery({
    queryKey: serviceRequestKeys.detail(row?.id ?? ''),
    queryFn: () => serviceRequestsApi.get(row!.id),
    enabled: !!row,
    placeholderData: row ?? undefined,
  });
  const request = row ? (fresh ?? row) : null;

  const { data: history, isPending } = useQuery({
    queryKey: serviceRequestKeys.history(request?.id ?? ''),
    queryFn: () => serviceRequestsApi.history(request!.id),
    enabled: !!request,
  });
  const rows = useMemo(() => toRows(history), [history]);

  /*
   * Поля вкладки «Заявка» собираются отдельным модулем (`serviceRequestViewFields`): их
   * двенадцать, у каждого своё правило показа, и вместе с устройством окна они перерастали
   * ограничение длины файла. Окно отвечает за вкладки, действия и запросы, состав полей — за
   * ответ «что с заявкой».
   */
  const allActions = request && actions ? actions(request) : [];
  /*
   * Назначение исполнителей ушло из меню карточки в саму карточку (ADR 0140): кнопка стоит у поля
   * «Исполнители», там же, где читают состав. Из меню оно здесь вычеркнуто — двум ручкам к одному
   * действию в одном окне взяться неоткуда; в меню строки списка пункт остаётся, там карточка не
   * открыта, и подпись «Вам: назначить исполнителей» ведёт прямо в окно (Р117).
   *
   * Пункт берётся готовым, а не строится заново: кому назначение доступно, решает коридор
   * переходов — и второй раз этот вопрос в портале не задаётся.
   */
  const assign = allActions.find((item) => item.key === 'assign');
  /*
   * Обсуждение (ADR 0141) тем же приёмом уходит из меню в подвал: у него есть счётчик, а меню
   * счётчиков не показывает — «есть ли там что-то новое» человек обязан видеть, не открывая
   * список действий. Пункт берётся готовым, а не строится заново: где обсуждение доступно, решает
   * тот же набор действий, что и для строки списка.
   */
  const chat = allActions.find((item) => item.key === 'chat');
  /*
   * «Принять в работу» — быстрой кнопкой рядом с «Действия» (Р6): главный шаг взятой заявки, и
   * прятать его в меню значило бы прятать саму работу. Пункт берётся готовым и из меню НЕ
   * вычёркивается, в отличие от назначения и обсуждения: на телефоне подвал карточки узкий, и
   * второй адрес у этого шага там единственный.
   */
  const start = allActions.find((item) => item.key === 'start');
  /*
   * Состав номенклатуры (Р15) правится кнопкой на вкладке «Номенклатура» — там же, где его читают,
   * тем же приёмом, что и назначение у поля «Исполнители». Из меню пункт поэтому вычеркнут: двум
   * ручкам к одному действию в одном окне взяться неоткуда.
   */
  const consumables = allActions.find((item) => item.key === 'consumables');
  /*
   * Перемещение техники (backlog §12) уходит из меню туда, где читают реквизиты, — кнопкой к полю
   * «Какой аппарат». Пункт берётся готовым, как назначение и обсуждение: доступность считает
   * предикат, а не поле.
   */
  const moveEquipment = allActions.find((item) => item.key === 'move-equipment');
  /* Правка заявки: в меню карточки пункт вычеркнут — его место здесь, главной кнопкой подвала. */
  const edit = allActions.find((item) => item.key === 'edit');
  const actionItems = cardMenuItems(allActions);

  const fields = request
    ? serviceRequestViewFields({
        request,
        user,
        onAssign: assign?.onClick,
        onMoveEquipment: moveEquipment?.onClick,
        // Тег статуса в поле «Статус» — тот же вход в ход заявки, что и в строке списка (ADR
        // 0161). Набор берётся КАРТОЧКИН: окно перехода обязано открыться внутри карточки, иначе
        // оно делит с ней слой и прячется под ней (ADR 0140).
        statusItems: allActions,
        statusPending: !!request && pendingId === request.id,
      })
    : [];

  return (
    <ViewModal
      title={request ? `Заявка ${request.displayNumber}` : 'Заявка'}
      open={!!request}
      onClose={onClose}
      width={1000}
      // Окно переоткрывают на соседней заявке: вкладка и раскрытые строки прошлой к ней
      // отношения не имеют.
      destroyOnHidden
      footer={[
        ...(request && chat
          ? [
              // Счётчик — двумя числами о разном: сколько всего сказано (подпись) и сколько
              // адресовано мне и не прочитано (бейдж). Одним числом они не складываются: «12»
              // на кнопке ничего не сообщало бы тому, кому написали только что.
              //
              // Синий, а не умолчательный красный: то же самое число синим стоит и меткой в
              // строке списка, и счётчиком в меню, а красный здесь читался бы как «ошибка,
              // требует внимания» — разные цвета одной величины и есть повод искать разницу,
              // которой нет.
              <Badge
                key="chat"
                count={request.chat.unreadMine}
                size="small"
                color="blue"
                offset={[-8, 4]}
              >
                <Button icon={<MessageOutlined />} onClick={chat.onClick}>
                  {request.chat.total > 0 ? `Обсуждение · ${request.chat.total}` : 'Обсуждение'}
                </Button>
              </Badge>,
            ]
          : []),
        ...(request && start
          ? [
              // Отдельной кнопкой слева от «Действия»: главный шаг статуса не должен требовать
              // второго нажатия, чтобы его увидели.
              <Button key="start" icon={<PlayCircleOutlined />} onClick={start.onClick}>
                {start.label}
              </Button>,
            ]
          : []),
        ...(actionItems.length > 0
          ? [
              // На телефоне действия открываются шитом снизу (ADR 0030), на десктопе — меню:
              // набор один и тот же, различается только способ до него дотянуться.
              isMobile ? (
                <Button key="actions" onClick={() => setSheetOpen(true)}>
                  Действия
                </Button>
              ) : (
                // Тот же триггер, что и в строке списка: прежде карточка теряла здесь `disabled`
                // вместе с причиной, и выключенное «Закрыть работы» нажималось, открывало окно и
                // упиралось в отказ сервера.
                <ActionMenuButton key="actions" items={actionItems}>
                  Действия
                </ActionMenuButton>
              ),
            ]
          : []),
        ...(edit
          ? [
              // Правка — главной кнопкой подвала, и пункт берётся ГОТОВЫМ, а не строится вторым
              // условием: прежде кнопка жила на своём пропе, а меню — на пункте набора, и два
              // источника одного права разошлись бы на первой же правке цикла.
              <Button key="edit" type="primary" onClick={edit.onClick}>
                {edit.label}
              </Button>,
            ]
          : []),
        <Button key="close" onClick={onClose}>
          Закрыть
        </Button>,
      ]}
    >
      {request && (
        <Tabs
          items={[
            {
              key: 'request',
              label: 'Заявка',
              children: (
                <>
                  <ViewFields items={fields} />
                  {request.equipmentDepartment == null && request.customerDepartment == null && (
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                      Заявка объектная: отдел у неё не указан.
                    </Typography.Text>
                  )}
                </>
              ),
            },
            /*
             * Предмет заявки — либо объём работ, либо номенклатура, и вкладка у них одна (Н1): у
             * расходников объёма работ нет вовсе (согласовывать картридж со своего склада не с
             * кем), а у ремонта нет строк выдачи. Две вкладки, из которых одна всегда пуста,
             * отвечали бы на вопрос «а где тут объём работ» каждый раз заново.
             *
             * Правит предмет заявки исполнитель, и правит его отсюда — на обеих вкладках одинаково
             * (Р15): у ремонта окном объёма работ, у расходников окном состава. Симметрия здесь не
             * украшение — у обоих видов заявки исполнитель отвечает на один вопрос, «что по ней
             * пойдёт», и два разных места для одного ответа расходятся на первой же правке.
             *
             * Заявителю (`audience === 'requester'`) вкладки объёма работ НЕ СТРОИТСЯ ВОВСЕ —
             * ADR 0160, решение 3: у него `items` пусты, суммы и согласование обнулены сервером, и
             * оставленная вкладка показывала бы пустую таблицу вместо ответа «денег вам не видно».
             * Прятать её стилем нельзя по той же причине, по которой сервер вычитает поля, а не
             * полагается на портал: спрятанное остаётся в разметке.
             *
             * Номенклатура при этом остаётся ОБЕИМ аудиториям: цен в строках расходников нет ни
             * одной (Р4), и запрет «Объёма работ» подменять запретом соседней вкладки значило бы
             * расширять задачу — предмет заявки на картридж заявитель обязан видеть.
             *
             * Аудитория читается из DTO, а не выводится из прав: сервер посчитал её для этой самой
             * строки, и второй ответ разъехался бы с первым — карточкой без вкладки при полных
             * данных либо вкладкой с пустой таблицей.
             */
            ...(request.kind === 'consumable'
              ? [
                  {
                    key: 'consumables',
                    label: 'Номенклатура',
                    children: (
                      <Space orientation="vertical" size={12} style={{ width: '100%' }}>
                        <ServiceConsumablesTable lines={request.consumables} />
                        {consumables && (
                          <Button
                            type="link"
                            size="small"
                            icon={<ProfileOutlined />}
                            style={{ padding: 0, alignSelf: 'flex-start' }}
                            onClick={consumables.onClick}
                          >
                            {consumables.label}
                          </Button>
                        )}
                      </Space>
                    ),
                  },
                ]
              : request.audience === 'finance'
                ? [
                    {
                      key: 'estimate',
                      label: 'Объём работ',
                      // Решения по объёму работ живут кнопками под таблицей (Р11): пункты берутся
                      // готовыми, чтобы вкладка и меню спрашивали одни и те же предикаты.
                      children: <ServiceRequestEstimate request={request} actions={allActions} />,
                    },
                  ]
                : []),
            {
              key: 'documents',
              label: 'Документы',
              children: <ServiceRequestDocuments request={request} />,
            },
            {
              key: 'history',
              label: 'История',
              children: isPending ? (
                <Spin size="small" />
              ) : rows.length > 0 ? (
                // Подписи полей — модульные: сервер шлёт технические ключи, а читателю истории
                // нужны слова заявки на обслуживание.
                <RequestHistoryTable
                  rows={rows}
                  labels={serviceRequestChangeLabels}
                  statuses={SERVICE_HISTORY_STATUSES}
                />
              ) : (
                <Typography.Text type="secondary">История недоступна</Typography.Text>
              ),
            },
          ]}
        />
      )}

      <ActionSheet
        title="Действия по заявке"
        open={sheetOpen}
        onClose={() => setSheetOpen(false)}
        items={actionItems}
      />

      {/* Окна действий — внутри карточки, а не соседями по странице (ADR 0140): только так antd
          считает им слой сам, и окно назначения не уходит под карточку, из которой его позвали. */}
      {modals}
    </ViewModal>
  );
}
