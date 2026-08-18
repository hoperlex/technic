import { Alert } from 'antd';
import { WAYBILL_CORRECTION_CONFIRM, type VehicleRouteDto } from '@technic/contracts';
import type { vehicleRoutesApi, waybillsApi } from '../../api/resources';
import { formatDateTime } from '../../utils/format';
import { formatDateOnly } from './shared';

/**
 * Цена коррекции рейса, прочитанная человеком **до** нажатия (ADR 0101, Р18 и Р36): какой номер
 * сгорит, чьи назначения переедут, какие подписи снимутся и что из бумаги уже ушло наружу.
 *
 * Вынесено из самого окна (`VehicleRouteCorrectionModal.tsx`) по границе предмета: там форма —
 * поля, правила и отправка, — а здесь перечень последствий, который растёт от каждой новой двери
 * заднего числа и к вводу не относится вовсе. Ратчет качества (`scripts/quality.mjs`) считает
 * строки у окна, и перечень тянул его вверх, ничего не добавляя форме.
 *
 * Считать здесь нечего: всё приходит готовым от сервера (`GET /vehicle-routes/:id/correction`) и
 * из карточки листа. Второй расчёт в портале разошёлся бы с тем, который потом исполнит операцию, —
 * и окно обещало бы не то, что произойдёт.
 */

type CorrectionPreview = Awaited<ReturnType<typeof vehicleRoutesApi.correctionPreview>>;
type WaybillCard = Awaited<ReturnType<typeof waybillsApi.get>>;

interface Props {
  /** Рейс, чей день исправляют; `null` — окно закрыто, и говорить не о чем. */
  route: VehicleRouteDto | null;
  preview: CorrectionPreview | undefined;
  /** Карточка действующего листа: отметки печати, выгрузки и подшитые файлы (Р18, Р34). */
  sheet: WaybillCard | undefined;
  /** Машина, выбранная в форме: ею отличается «сменит машину» от «ехала та же». */
  vehicleId: string | undefined;
}

export function RouteCorrectionConsequences({ route, preview, sheet, vehicleId }: Props) {
  /** Заявки, у которых коррекция перепишет назначение: линейные дни в их число не входят. */
  const reassigned = (preview?.requests ?? []).filter(
    (r) => r.workDate === null && r.assignedVehicleId !== vehicleId,
  );
  const linearDays = (preview?.requests ?? []).filter((r) => r.workDate !== null);

  return (
    <Alert
      type="warning"
      showIcon
      message={`Что произойдёт с рейсом за ${route ? formatDateOnly(route.routeDate) : ''}`}
      description={
        <ul style={{ margin: 0, paddingInlineStart: 20 }}>
          <li>
            {preview?.waybill
              ? `Номер ${preview.waybill.number} будет аннулирован, взамен выпишется следующий по серии.`
              : 'Действующего листа у рейса нет — коррекция выпишет новый номер.'}
          </li>
          {reassigned.length > 0 && (
            <li>
              Машину сменят заявки: {reassigned.map((r) => r.displayNumber).join(', ')} — рейс
              источник истины о том, чем едут; ставки при этом не трогаются.
            </li>
          )}
          {/* Линейный день (ADR 0100 п. 4): машина дня это машина рейса, а назначение заказа
            отвечает за весь его срок и остаётся прежним. Сказать это нужно там же, где перечислены
            сменившие машину, — иначе список прочтётся и про дни. */}
          {linearDays.length > 0 && (
            <li>
              Дни линейных заказов ({linearDays.map((r) => r.displayNumber).join(', ')}) поедут
              машиной рейса. Назначение самих заказов не меняется — его правят в карточке заявки.
            </li>
          )}
          {(preview?.shifts ?? []).map((s) => (
            <li key={`${s.requestId}@${s.date}`}>
              Снимется подпись смены {s.displayNumber} за {formatDateOnly(s.date)}
              {s.approvedByName ? ` (принял ${s.approvedByName})` : ''} — часы останутся,
              подтвердить их придётся заново.
            </li>
          ))}
          {sheet?.printedAt && <li>Лист уже печатали {formatDateTime(sheet.printedAt)}.</li>}
          {sheet?.exportedAt && (
            <li>Лист уже выгружали файлом {formatDateTime(sheet.exportedAt)}.</li>
          )}
          {(sheet?.files.length ?? 0) > 0 && (
            <li>
              К старому листу подшито файлов: {sheet!.files.length} — на новый номер они не
              переедут, переподшейте вручную.
            </li>
          )}
          <li>{WAYBILL_CORRECTION_CONFIRM}</li>
        </ul>
      }
    />
  );
}
