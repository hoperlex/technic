import { Alert } from 'antd';
import { WAYBILL_CORRECTION_CONFIRM, type VehicleRouteDto } from '@technic/contracts';
import { formatDateOnly, formatDateTime } from '@shared/lib';
import type { vehicleRoutesApi } from '@entities/vehicle-route';
import type { waybillsApi } from '@entities/waybill';

/**
 * The cost of a route correction, read by the person **before** the press (ADR 0101, R18 and
 * R36): which number burns, whose assignments move, which sign-offs are removed and which paper
 * has already gone out.
 *
 * Extracted from the window itself (`VehicleRouteCorrectionModal.tsx`) along a subject boundary:
 * the window holds the form (fields, rules and submission), while this is the list of
 * consequences, which grows with every new backdating door and has nothing to do with input. The
 * quality ratchet (`scripts/quality.mjs`) counts the window's lines, and the list was pushing it
 * up without adding anything to the form.
 *
 * Nothing is computed here: everything comes ready from the server
 * (`GET /vehicle-routes/:id/correction`) and from the sheet card. A second calculation in the
 * portal would drift from the one that later executes the operation, and the window would promise
 * something other than what actually happens.
 */

type CorrectionPreview = Awaited<ReturnType<typeof vehicleRoutesApi.correctionPreview>>;
type WaybillCard = Awaited<ReturnType<typeof waybillsApi.get>>;

interface Props {
  /** The route whose day is corrected; `null` means the window is closed, nothing to say. */
  route: VehicleRouteDto | null;
  preview: CorrectionPreview | undefined;
  /** Card of the current sheet: print and export marks and attached files (R18, R34). */
  sheet: WaybillCard | undefined;
  /** Vehicle chosen in the form: tells "will change the vehicle" from "the same one drove". */
  vehicleId: string | undefined;
}

export function RouteCorrectionConsequences({ route, preview, sheet, vehicleId }: Props) {
  /** Requests whose assignment the correction rewrites; linear days are not among them. */
  const reassigned = (preview?.requests ?? []).filter(
    (r) => r.workDate === null && r.assignedVehicleId !== vehicleId,
  );
  const linearDays = (preview?.requests ?? []).filter((r) => r.workDate !== null);

  return (
    <Alert
      type="warning"
      showIcon
      title={`Что произойдёт с рейсом за ${route ? formatDateOnly(route.routeDate) : ''}`}
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
          {/* A linear day (ADR 0100 item 4): the day's vehicle is the route's vehicle, while the
            order's assignment covers its whole term and stays unchanged. This must be said right
            next to the list of requests changing vehicle, otherwise that list would be read as
            covering the days too. */}
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
