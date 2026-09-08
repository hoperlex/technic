import { Button, Space, Typography } from 'antd';
import {
  canCoordinateServiceRequests,
  serviceRequestHasEffectivePendingEstimate,
  serviceRequestNeedsEstimate,
  type ServiceRequestDto,
} from '@technic/contracts';
import { ServiceEstimateTable, ServiceHint } from '@entities/service-request';
import type { ActionSheetItem } from '@shared/ui';
import { useAuth } from '../../auth/AuthContext';
import { serviceActionRow } from './serviceRequestRow';
import { formatDateTime, formatMoney } from '../../utils/format';

/** Решения по объёму работ, которые вкладка показывает кнопками: их порядок здесь и есть порядок. */
const DECISION_KEYS = ['approve', 'reject', 'reopen'] as const;

/**
 * Что говорит вкладка внутренней заявки, у которой объём работ остался от прошлого (Р7).
 *
 * Ровно то, что человеку нужно знать: строки настоящие, читать их можно, а шага по ним больше нет.
 * Прежняя плашка состояния на этом месте соврала бы в любом из трёх своих видов — «ждём решения»
 * обещало бы согласующего, которого после Р5 не существует; «согласования нет» звало бы его
 * получить.
 */
const HISTORICAL_ESTIMATE_HINT =
  'Исторический объём работ; после перехода на внутреннее исполнение решение по нему не требуется.';

/**
 * Вкладка «Объём работ» карточки (§9.4, Р17): текущая ревизия, отметка «согласована ревизия N»,
 * план и факт по строкам, итоги — и сами решения по предъявленному объёму.
 *
 * Отметка о состоянии стоит выше строк не для порядка: спор по заявке начинается с вопроса «а это
 * утверждали?», и ответ на него — номер ревизии со снимком «кто и когда», а не сумма.
 *
 * **Активное предъявление определяет только признак `serviceEstimatePending`** (Р9), а не непустая
 * дата. Прежде вкладка считала предъявлением сам факт непустого `estimateSubmittedAt`, и после
 * правки это соврало бы: возврат в правку дату не трогает — она сохраняет свой прежний смысл «когда
 * предъявляли в последний раз», — и «предъявлена» стояло бы у отозванного. Поэтому дата и подписана
 * временем последнего предъявления, а не состоянием.
 *
 * Решения переехали сюда из одного лишь меню по просьбе заказчика: смотрят на объём работ здесь, и
 * подписывать его отсюда же. Кнопки строит не вкладка — она получает готовые пункты набора
 * действий, а те спрашивают предикаты Р11. Два входа в одно действие не дублирование ровно до тех
 * пор, пока оба спрашивают одно правило; посчитай вкладка доступность сама — она разошлась бы с
 * меню и с сервером молча.
 */
export function ServiceRequestEstimate({
  request,
  actions = [],
}: {
  request: ServiceRequestDto;
  /**
   * Полный набор действий карточки. Вкладка выбирает из него свои три — «Согласовать», «Не
   * согласовано» и «Вернуть в правку»; нет пункта — нет и кнопки, и решать, почему, вкладке не
   * приходится.
   */
  actions?: ActionSheetItem[];
}) {
  const { user } = useAuth();
  const approval = request.approval;
  const completion = request.completion;
  const row = serviceActionRow(request);
  /*
   * ИСТОРИЧЕСКАЯ ВКЛАДКА (Р7): объёма работ у внутреннего ремонта не бывает, а строки у него быть
   * могут — до этой волны согласование проходили все ремонтные заявки. Вкладку такой заявке
   * оставляет `estimateRevision > 0` (правило вкладок карточки), и она только читается.
   *
   * Своей проверки прав здесь нет и не заводится: кнопки решений приходят готовыми пунктами набора
   * действий, а их предикаты уже спрашивают тот же признак Р4. Посчитай вкладка доступность сама —
   * она разошлась бы с меню и с сервером молча, ровно как до ADR 0162.
   */
  const historical = !serviceRequestNeedsEstimate(row);
  /*
   * Ожидание ДЕЙСТВУЮЩЕЕ, а не сырая колонка (Н11): сохранившийся у внутренней заявки pending
   * подписывать некому, и «ждём решения» на нём было бы обещанием шага, которого нет.
   */
  const pending = serviceRequestHasEffectivePendingEstimate(row);
  const coordinator = canCoordinateServiceRequests(user);
  // Факт показывается, как только он появился хоть у одной строки: возврат на доработку стирает
  // отметки, и тогда таблица снова становится планом.
  const showFact = request.items.some((item) => item.performed != null);
  const decisions = DECISION_KEYS.map((key) => actions.find((item) => item.key === key)).filter(
    (item): item is ActionSheetItem => !!item,
  );

  /*
   * Кнопки решений — единственный вход в согласование ИЗ КАРТОЧКИ: из её меню пункты вычеркнуты
   * (ADR 0162), потому что подпись под цифрой ставят там, где цифру видно. Отсюда и требование к
   * этому месту: кнопки обязаны быть везде, где решение доступно, — иначе вычеркнутый пункт
   * оставляет карточку без входа вовсе.
   */
  const decisionButtons = decisions.length > 0 && (
    <Space wrap>
      {decisions.map((item) => (
        <Button
          key={item.key}
          // Главное решение — сплошной кнопкой: у согласования оно одно, и признак `primary`
          // проставлен там же, где строится сам пункт (Р117).
          type={item.primary ? 'primary' : 'default'}
          danger={item.danger}
          icon={item.icon}
          onClick={item.onClick}
        >
          {item.key === 'approve'
            ? 'Согласовать'
            : item.key === 'reject'
              ? 'Не согласовано'
              : 'Вернуть в правку'}
        </Button>
      ))}
    </Space>
  );

  /*
   * Состояние ревизии одной строкой (Р7): у исторической внутренней заявки она нейтральная —
   * подпись прошлого согласования рядом, если она была, потому что именно ею объясняется, на каком
   * основании тогда работали. Стереть её значило бы потерять прошлое.
   */
  const historicalLine = (
    <Typography.Text type="secondary">
      {HISTORICAL_ESTIMATE_HINT}
      {approval &&
        ` Согласована ревизия ${approval.revision} · ${approval.byName || '—'} · ${formatDateTime(approval.at)}.`}
    </Typography.Text>
  );

  if (request.items.length === 0) {
    /*
     * Строк нет — но решение по нему бывает и здесь: предъявить пустой объём работ сервер
     * позволяет (гарантийный ремонт — это осознанное «чиним, денег нет»), и согласующему такую
     * ревизию всё равно подписывать. Показать один лишь текст значило бы спрятать от него
     * единственный вход.
     *
     * Историческая внутренняя ревизия сюда тоже попадает — и говорит своё: «объём собирает
     * исполнитель» на ней было бы прямой неправдой, собирать его больше некому.
     */
    return (
      <Space orientation="vertical" size={12} style={{ width: '100%' }}>
        {historical ? (
          historicalLine
        ) : (
          <Typography.Text type="secondary">
            {pending
              ? 'Объём работ предъявлен без строк — по нему нечего считать, но решение по ревизии нужно.'
              : 'Объёма работ пока нет: его собирает исполнитель, взявший заявку в работу.'}
          </Typography.Text>
        )}
        {decisionButtons}
      </Space>
    );
  }

  return (
    <Space orientation="vertical" size={12} style={{ width: '100%' }}>
      {historical ? (
        historicalLine
      ) : (
        <ServiceHint
          coordinator={coordinator}
          // Три состояния, а не два: «ждёт решения» отличается от «согласовано» и от «в правке»
          // тем, что ход сейчас за согласующим, — и именно об этом вкладку и спрашивают.
          level={pending ? 'warning' : approval ? 'success' : 'info'}
          title={
            pending
              ? `Ревизия ${request.estimateRevision} предъявлена — ждём решения`
              : approval
                ? `Согласована ревизия ${approval.revision}`
                : `Ревизия ${request.estimateRevision} — согласования нет`
          }
          description={
            pending ? (
              <span>
                {request.estimateSubmittedAt
                  ? `Предъявлена ${formatDateTime(request.estimateSubmittedAt)}`
                  : 'Предъявлена'}
                {/* Подпись под прошлой ревизией при висящем предъявлении — обычное дело: объём
                    предъявили заново, и старое согласование к делу больше не относится. Сказать
                    это надо прямо, иначе «Согласована ревизия 2» вспоминалось бы как
                    действующее. */}
                {approval && approval.revision !== request.estimateRevision && (
                  <Typography.Text type="secondary">
                    {' '}
                    · прошлое согласование (ревизия {approval.revision}) больше не действует
                  </Typography.Text>
                )}
              </span>
            ) : approval ? (
              <span>
                {approval.byName || '—'} · {formatDateTime(approval.at)}
                {/* Ревизии разошлись — значит объём работ предъявляли после согласования: к работам
                    сервер пустит только по совпадению номеров (Р14). */}
                {approval.revision !== request.estimateRevision && (
                  <Typography.Text type="warning">
                    {' '}
                    · объём работ правился, текущая ревизия {request.estimateRevision}
                  </Typography.Text>
                )}
              </span>
            ) : request.estimateSubmittedAt ? (
              // Дата непуста, а предъявления нет — значит объём вернули в правку (Р9). Дата отвечает
              // на «когда предъявляли в последний раз», и подписана она именно так.
              `В правке у исполнителя · предъявляли ${formatDateTime(request.estimateSubmittedAt)}`
            ) : (
              'Черновик исполнителя: на согласование ещё не отправлялся'
            )
          }
        />
      )}

      <ServiceEstimateTable items={request.items} showFact={showFact} />

      <Space orientation="vertical" size={2} style={{ alignItems: 'flex-end', width: '100%' }}>
        <span>
          <Typography.Text type="secondary">По объёму работ: </Typography.Text>
          <Typography.Text strong>{formatMoney(request.estimatedTotalAmount)}</Typography.Text>
        </span>
        {completion?.adjustmentAmount != null && (
          <span>
            <Typography.Text type="secondary">Скидка по акту: </Typography.Text>
            <Typography.Text>{formatMoney(completion.adjustmentAmount)}</Typography.Text>
            {completion.adjustmentReason && (
              <Typography.Text type="secondary"> · {completion.adjustmentReason}</Typography.Text>
            )}
          </span>
        )}
        {completion && (
          <span>
            <Typography.Text type="secondary">По акту: </Typography.Text>
            <Typography.Text strong style={{ fontSize: 16 }}>
              {formatMoney(completion.totalAmount)}
            </Typography.Text>
            <Typography.Text type="secondary">
              {' '}
              · закрыто {formatDateTime(completion.completedAt)}
            </Typography.Text>
          </span>
        )}
      </Space>

      {/* Решения — под таблицей и под итогом, а не над ними: подпись ставят, дочитав до суммы. */}
      {decisionButtons}
    </Space>
  );
}
