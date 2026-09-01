import { useEffect, useState } from 'react';
import { Alert, Checkbox, Form, Input, Typography } from 'antd';
import { useQuery } from '@tanstack/react-query';
import {
  WAYBILL_CORRECTION_CONFIRM,
  type WeeklyCorrectionBody,
  type WeeklyVehicleRequestDto,
} from '@technic/contracts';
import { weeklyRequestsApi } from '../../api/resources';
import { weeklyRequestKeys } from '@entities/weekly-request';
import { FormModal } from '@shared/ui';
import { formatDateOnly } from './shared';

/**
 * Проведение просроченной недели задним числом (ADR 0085 + ADR 0101).
 *
 * Виза обычной недели вопросов не задаёт: сроки двигаются вперёд, бумага выписывается на дни,
 * которых ещё не было. Просроченная неделя — другое действие той же кнопки: она продлевает заказы
 * за **уже отработанные** дни, выписывает за них бланки строгой отчётности и, если у недели уже
 * есть листы ЭСМ-2, жжёт их номера. Цену эту называет человек, а не выводит сервер из даты в
 * шапке, — поэтому отдельное окно, а не тихо добавленное поле к прежней кнопке.
 *
 * Устроено как окно коррекции рейса (`VehicleRouteCorrectionModal`) и по той же причине:
 * последствия считает сервер тем же кодом, которым будет их исполнять (`GET /:id/correction`).
 * Второй расчёт в портале разошёлся бы с первым — и окно обещало бы не то, что произойдёт.
 *
 * Чего здесь нет: состава. Его правят на самой странице, и повторять его перечнем в окне значило
 * бы дать два ответа на вопрос «что согласуют». Окно отвечает на другой вопрос — чего это стоит в
 * прошлом.
 */

interface FormValues {
  reason: string;
  unlockWaybillIds: string[];
}

interface Props {
  /** Заявка, которую проводят; `null` — окно закрыто. */
  request: WeeklyVehicleRequestDto | null;
  onClose: () => void;
  /**
   * Провести: блок коррекции целиком. Виза уходит тем же вызовом, что и обычная, и мутация живёт
   * на странице — там же, где разбор 409 и 422, и там же, где состав сохраняется тем же движением.
   */
  onConduct: (correction: WeeklyCorrectionBody) => void;
  pending: boolean;
}

export function WeeklyRequestConductModal({ request, onClose, onConduct, pending }: Props) {
  const [form] = Form.useForm<FormValues>();

  /**
   * Ключ идемпотентности (Р31 ADR 0101): придумывается **до** отправки и держится, пока окно
   * открыто на этой заявке. Повтор после обрыва связи обязан вернуть результат прежней операции
   * (200 и `apply: null`), а не продлить сроки второй раз и не сжечь второй номер бланка.
   */
  const [operationId, setOperationId] = useState(() => crypto.randomUUID());
  useEffect(() => {
    if (!request) return;
    setOperationId(crypto.randomUUID());
    form.setFieldsValue({ reason: '', unlockWaybillIds: [] });
    // Зависимость — только идентификатор заявки: следи эффект за объектом целиком, ключ операции и
    // написанная причина перескакивали бы под рукой на каждом обновлении карточки, а ключ обязан
    // держаться неизменным всё время, пока окно открыто.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request?.id, form]);

  /** Цена операции и её запреты — сервером, теми же правилами, которыми он их и исполнит. */
  const { data: preview, isFetching } = useQuery({
    // Ключ фабрикой слайса, но массив тот же: страница гасит запросы префиксом
    // `['weekly-vehicle-requests', …]`, и разошедшийся ключ тихо оставил бы окно со старым
    // предпросмотром — после визы, которая уже сдвинула сроки.
    queryKey: weeklyRequestKeys.correction(request?.id),
    queryFn: () => weeklyRequestsApi.correctionPreview(request!.id),
    enabled: !!request,
  });

  /** Провести нельзя вовсе: право, глубина или состояние документа — сервер называет одну причину. */
  const blocked = !!preview && !preview.allowed;

  const submit = (v: FormValues) => {
    // Отказ, уже названный предпросмотром, второй раз не спрашивается: ручка ответит тем же
    // текстом, но после написанной причины и нажатой кнопки, — а прочитать его человек должен был
    // до того, как её писать.
    if (blocked) return;
    onConduct({ operationId, reason: v.reason.trim(), unlockWaybillIds: v.unlockWaybillIds ?? [] });
  };

  return (
    <FormModal
      title={
        request
          ? `${request.displayNumber} · провести неделю задним числом`
          : 'Проведение недели задним числом'
      }
      open={!!request}
      onCancel={onClose}
      onSubmit={() => form.submit()}
      confirmLoading={pending}
      okText="Провести и завизировать"
      okDanger
      width={720}
    >
      <Form<FormValues> form={form} layout="vertical" onFinish={submit}>
        {/* Отказ читается первым: право, глубина и состояние документа — три разные причины, и
          чинит их не тот, кто открыл окно. Кнопка при этом остаётся на месте и просто не
          отправляет: исчезнувшая кнопка не объясняет, почему её нет. */}
        {blocked && (
          <Alert
            type="error"
            showIcon
            style={{ marginBottom: 16 }}
            title="Эту неделю сейчас не провести"
            description={preview!.blockedReason}
          />
        )}

        {preview && (
          <Alert
            type="warning"
            showIcon
            style={{ marginBottom: 16 }}
            title={`Что произойдёт с неделей ${preview.weekLabel}`}
            description={
              <ul style={{ margin: 0, paddingInlineStart: 20 }}>
                <li>
                  Сроки заказов продлятся за уже прошедшие дни — до{' '}
                  {formatDateOnly(preview.weekEnd)} включительно.
                </li>
                {/* «Просрочена» и «задним числом» — не одно и то же: у начавшейся недели
                  воскресенье ещё впереди, и вердикт `backdateGuard` у неё отрицательный. Сказать
                  это надо здесь, иначе человек прочтёт про прошлое там, где прошлого нет. */}
                <li>
                  {preview.backdated
                    ? `Операция идёт задним числом: её эффективная дата — воскресенье недели, ${formatDateOnly(preview.effectiveDate)}, и оно уже прошло.`
                    : `Неделя началась, но не кончилась: её воскресенье ${formatDateOnly(preview.effectiveDate)} ещё впереди, и правкой прошедшего дня операция не считается — но согласуются по ней уже отработанные дни.`}
                </li>
                <li>
                  Причина и ключ операции останутся в журнале коррекций вместе с вашим именем: через
                  месяцы по ним объяснят, почему неделю согласовали после неё, а не до.
                </li>
                {preview.pastWeeks.length > 0 && (
                  <li>
                    За прошедшие недели выпишется бумага, которой у заказов нет:{' '}
                    {preview.pastWeeks
                      .map(
                        (w) =>
                          `${w.displayNumber} · ${formatDateOnly(w.from)} – ${formatDateOnly(w.to)}`,
                      )
                      .join('; ')}
                    .
                  </li>
                )}
                {preview.unlockable.length > 0 && <li>{WAYBILL_CORRECTION_CONFIRM}</li>}
                {/* Необратимость — последней строкой и без обиняков: «отменить визу» у недельной
                  заявки не существует, срок сокращают досрочным завершением по каждой машине
                  (ADR 0044), а списанный номер бланка не возвращается ничем. */}
                <li>
                  Отменить проведение одной кнопкой нельзя: сроки сокращают досрочным завершением по
                  каждой машине, а списанный номер бланка не возвращается.
                </li>
              </ul>
            }
          />
        )}

        {/* Листы отработанных недель — поимённо (Р11 ADR 0101), а не «все прошлые»: после линейной
          техники в одной неделе законно живут листы двух машин (ADR 0100 п. 7), и общая галочка
          сожгла бы не тот номер. Неназванный лист остаётся нетронутым — разблокировка адресная и
          сама в стороны не растёт. */}
        <Form.Item
          name="unlockWaybillIds"
          label="Листы ЭСМ-2 к перевыписке"
          extra={
            (preview?.unlockable.length ?? 0) > 0
              ? 'Отмеченные номера будут аннулированы, взамен выпишутся новые — следующими по серии. Неотмеченная неделя останется с прежним листом и прежним сроком'
              : 'Действующих листов за отработанные недели у состава нет: переписывать нечего'
          }
        >
          <Checkbox.Group
            style={{ display: 'flex', flexDirection: 'column', gap: 4 }}
            options={(preview?.unlockable ?? []).map((w) => ({
              value: w.waybillId,
              label: `${w.displayNumber} · № ${w.number} · ${formatDateOnly(w.periodFrom)} – ${formatDateOnly(w.periodTo)}`,
            }))}
          />
        </Form.Item>

        {/* Причина обязательна и здесь, и на сервере (422 без неё): она уезжает в запись операции и
          в выписанные ею листы (Р35 ADR 0101) — и остаётся единственным объяснением того, почему
          неделю согласовали после того, как её отработали. */}
        <Form.Item
          name="reason"
          label="Причина проведения задним числом"
          rules={[{ required: true, message: 'Укажите причину' }]}
          extra="Останется в журнале коррекций и в листах, выписанных этой операцией"
        >
          <Input.TextArea
            rows={2}
            maxLength={2000}
            showCount
            placeholder="Например: техника отработала неделю по устной договорённости, заявку оформили в понедельник"
          />
        </Form.Item>

        {/* Глубина права — справкой, а не запретом: за её пределом сервер сам ответит отказом выше,
          а здесь строка отвечает на вопрос «докуда я вообще могу», пока он не стал отказом. */}
        {preview?.correctionFloor && (
          <Typography.Text type="secondary">
            Ваша глубина коррекции — недели, кончившиеся не раньше{' '}
            {formatDateOnly(preview.correctionFloor)}; давность больше этой проводит администратор.
          </Typography.Text>
        )}
        {isFetching && !preview && (
          <Typography.Text type="secondary">Считаем последствия…</Typography.Text>
        )}
      </Form>
    </FormModal>
  );
}
