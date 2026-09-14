import { Typography } from 'antd';
import {
  serviceEstimateExemptionOutcomeLabels,
  type ServiceRequestDto,
  type ServiceRequestEstimateExemptionDto,
} from '@technic/contracts';
import { ServiceHint } from '@entities/service-request';
import { formatDateTime } from '../../utils/format';

/**
 * СОСТОЯНИЕ ДЕЙСТВУЮЩЕЙ РЕВИЗИИ ОДНОЙ ПЛАШКОЙ: ждут решения, согласована человеком либо принята
 * без согласования (Р3 плана `docs/office-equipment-on-site-and-invoice-estimate-plan.md`).
 *
 * Отдельным модулем от самой вкладки, и граница та же, по которой в списке отделены ячейки
 * (`serviceRequestCells`): вкладка отвечает «что показать и в каком порядке», а здесь живёт
 * единственный вопрос — **на каком основании по этой ревизии работают**. Объяснения к нему длиннее
 * разметки, и во вкладке они тонули; у неё к тому же две ветки (со строками и без), и плашка нужна
 * обеим — у документной ревизии строк нет вовсе.
 */

/**
 * Кто и когда заявил освобождение от подписи (Р3, Р13).
 *
 * Имя из снимка ЗАЯВЛЕНИЯ, а не из подписи согласования: у применённого освобождения подписавшего
 * нет вовсе (`estimate_approval_source = 'auto'` запрещает автора), и «Согласовал: —» на его месте
 * читалось бы как потерянные данные. Пояснение исполнителя («мелкий ремонт на месте») идёт следом
 * — оно и есть единственное, что человек сказал о причине.
 */
function exemptionWords(exemption: ServiceRequestEstimateExemptionDto): string {
  const who = exemption.byName || '—';
  return `${who} · ${formatDateTime(exemption.at)}${exemption.note ? ` · ${exemption.note}` : ''}`;
}

export function ServiceEstimateStateLine({
  request,
  /** Держатель `serviceRequests.assign`: считает вызывающий (`canCoordinateServiceRequests`). */
  coordinator,
  /** Ожидание ДЕЙСТВУЮЩЕЕ (`serviceRequestHasEffectivePendingEstimate`), а не сырая колонка (Н11). */
  pending,
}: {
  request: ServiceRequestDto;
  coordinator: boolean;
  pending: boolean;
}) {
  const approval = request.approval;
  /*
   * ЗАЯВЛЕНИЕ ОБ ОСВОБОЖДЕНИИ ЧИТАЕТСЯ ТОЛЬКО ПО ДЕЙСТВУЮЩЕЙ РЕВИЗИИ (Р3, Р9). Заявлений по заявке
   * бывает несколько — предъявили, вернули в правку, предъявили снова, — и сервер отдаёт последнее
   * вместе с номером его ревизии. Заявление по ПРОШЛОЙ ревизии снято переизданием: покажи вкладка
   * его как живое, человек читал бы снятое основание денежного решения как действующее.
   */
  const exemption =
    request.exemption && request.exemption.revision === request.estimateRevision
      ? request.exemption
      : null;
  /*
   * ТРИ СОСТОЯНИЯ, А НЕ ДВА (Р3). `applied` — подпись проставило автопринятие, и автора у неё нет
   * вовсе; `observed` — заявление записано, но рубильник выключен, и подпись собирают обычным
   * порядком; заявления нет — обычное согласование человеком, как было всегда.
   *
   * У применённого спрашивается ещё и снимок подписи по ТОЙ ЖЕ ревизии — тем же слагаемым, каким
   * сервер считает `exemptionApplied`: возврат в правку снимает подпись, ревизии не поднимая, и
   * строка заявления при этом остаётся. Без этой проверки вкладка говорила бы «принято без
   * согласования» у заявки, которую как раз вернули исполнителю.
   */
  const autoAccepted =
    exemption?.outcome === 'applied' && approval?.revision === request.estimateRevision
      ? exemption
      : null;
  const declared = exemption?.outcome === 'observed' ? exemption : null;
  /*
   * Заявленное, но НЕ применённое освобождение — строкой рядом с состоянием ревизии. Подпись по
   * такой заявке ждут как обычно, и молчание об этом стоило бы исполнителю ровно того, ради чего
   * он ставил галочку: он считал бы заявку принятой.
   */
  const declaredLine = declared && (
    <Typography.Text type="warning">
      {' '}
      · {serviceEstimateExemptionOutcomeLabels.observed}: заявил {exemptionWords(declared)} —
      освобождение записано, но не применено
    </Typography.Text>
  );

  return (
    <ServiceHint
      coordinator={coordinator}
      // Три состояния, а не два: «ждёт решения» отличается от «согласовано» и от «в правке»
      // тем, что ход сейчас за согласующим, — и именно об этом вкладку и спрашивают.
      level={pending ? 'warning' : approval ? 'success' : 'info'}
      title={
        pending
          ? `Ревизия ${request.estimateRevision} предъявлена — ждём решения`
          : autoAccepted
            ? /* Не «Согласована ревизия N»: согласования не было, и подписавшего у неё нет (Р3). */
              `${serviceEstimateExemptionOutcomeLabels.applied} — ревизия ${request.estimateRevision}`
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
                предъявили заново, и старое согласование к делу больше не относится. Сказать это
                надо прямо, иначе «Согласована ревизия 2» вспоминалось бы как действующее. */}
            {approval && approval.revision !== request.estimateRevision && (
              <Typography.Text type="secondary">
                {' '}
                · прошлое согласование (ревизия {approval.revision}) больше не действует
              </Typography.Text>
            )}
            {declaredLine}
          </span>
        ) : autoAccepted ? (
          <span>
            Освобождение от подписи заявил {exemptionWords(autoAccepted)}
            <Typography.Text type="secondary">
              {' '}
              · подписи под ревизией нет: согласование по ней не собирали
            </Typography.Text>
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
            {declaredLine}
          </span>
        ) : request.estimateSubmittedAt ? (
          <span>
            {/* Дата непуста, а предъявления нет — значит объём вернули в правку (Р9). Дата
                отвечает на «когда предъявляли в последний раз», и подписана она именно так. */}
            {`В правке у исполнителя · предъявляли ${formatDateTime(request.estimateSubmittedAt)}`}
            {declaredLine}
          </span>
        ) : (
          <span>Черновик исполнителя: на согласование ещё не отправлялся{declaredLine}</span>
        )
      }
    />
  );
}
