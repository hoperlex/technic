import { Alert, Form, Input, Typography } from 'antd';
import type { DriverReportDto, ReportDiscrepancyDto } from '@technic/contracts';
import { vehicleReadingsApi } from '@entities/vehicle-reading';
import { FormModal } from '@shared/ui';
import { formatDateOnly } from '../../utils/date';
import { useIntakeAction } from './intakeAction';

/**
 * Приведение снимка к источнику (ADR 0103, решение 11; план «Показания техники», §7).
 *
 * Это выход из тупика, а не рядовая правка, и окно обязано этим быть. Рейс законно переназначили
 * после отправки: у прежнего работника висит расхождение, у нового — `missing_source`, а добавить
 * ему источник нельзя — глобальный `UNIQUE (route_id)` занят чужой строкой. Единственный способ не
 * оставить показание навсегда у чужого человека — перенести строку **вместе с показанием** в отчёт
 * того, кто по документу ехал.
 *
 * Отсюда три свойства окна:
 *
 * 1. **Последствие названо словами до нажатия — вместе с целью.** Кто и за какой день едет по
 *    документу, говорит сервер (`ReportDiscrepancyDto.target`): портал источника не читает и
 *    вывести из вида расхождения ни человека, ни дату не может. Кнопка, подписанная одним
 *    «Применить», обещала бы правку внутри этого дня.
 * 2. **Причина обязательна.** Перенос учётного числа между людьми объясняют, и объяснение уезжает
 *    в обе истории — исходного отчёта и целевого.
 * 3. **Версий уходит две.** Перенос двигает обе шапки, и версия целевого отчёта — вся защита от
 *    двух диспетчеров, переносящих строки в один и тот же день. Её портал берёт из той же цели:
 *    день цели уже открыт — версия есть и едет в теле; день никто не открывал — шапки нет вовсе, и
 *    заведёт её сам перенос.
 */

/**
 * Отказ по версии здесь лечится повтором, и текст говорит именно это. Единственный случай, когда
 * версии в теле не было, — целевой отчёт, заведённый между чтением карточки и нажатием: перечитанная
 * карточка уже назовёт его версию, и вторая попытка пройдёт.
 */
const CONFLICT =
  'Снимок не приведён: отчёт или источник изменились, пока карточка была открыта. Карточка ' +
  'перечитана — проверьте расхождение и повторите перенос';

export function IntakeRebaseModal({
  report,
  discrepancy,
  onClose,
}: {
  report: DriverReportDto;
  /** Расхождение с непустым `itemId`: переносится строка, а не расхождение. */
  discrepancy: ReportDiscrepancyDto & { itemId: string };
  onClose: () => void;
}) {
  const [form] = Form.useForm<{ reason: string }>();
  const item = report.items.find((i) => i.id === discrepancy.itemId);
  const target = discrepancy.target;

  /**
   * Версии обоих отчётов. Ключ — идентификатор, поэтому случай «цель это тот же отчёт» (сменилась
   * одна машина) сам сворачивается в одну запись, а не шлёт версию дважды.
   */
  const targetVersion =
    target && target.reportId !== null && target.reportVersion !== null
      ? { [target.reportId]: target.reportVersion }
      : {};
  const reportVersions: Record<string, number> = {
    [report.id]: report.version,
    ...targetVersion,
  };

  const rebase = useIntakeAction({
    run: (values: { reason: string }) =>
      vehicleReadingsApi.rebaseItem(discrepancy.itemId, {
        reason: values.reason.trim(),
        reportVersions,
      }),
    done: 'Строка переехала в отчёт по источнику',
    conflict: CONFLICT,
    onDone: onClose,
  });

  /**
   * Куда переедет строка — словами сервера: кто по документу едет и за какой день. Имя стоит
   * в именительном падеже и через запятую с датой намеренно: склонять фамилию из справочника
   * портал не умеет, а «переедет к Сидоров С. С.» читалось бы как сбой подстановки.
   */
  const destination = target
    ? `${target.personName || 'работник источника'}, ${formatDateOnly(target.date)}`
    : null;

  return (
    <FormModal
      title="Привести снимок к источнику"
      open
      onCancel={onClose}
      onSubmit={() => form.submit()}
      confirmLoading={rebase.isPending}
      okText="Перенести строку"
      okDanger
      width={560}
    >
      <Form form={form} layout="vertical" onFinish={(values) => rebase.mutate(values)}>
        <Alert type="warning" showIcon message={discrepancy.message} style={{ marginBottom: 16 }} />

        {/* Последствие названо целиком: это не правка внутри дня, а переезд учётного числа к
            другому человеку — и адресат назван по имени, а не «тому, кто ехал». */}
        <Alert
          type="error"
          showIcon
          style={{ marginBottom: 16 }}
          message={
            destination ? `Строка переедет в отчёт: ${destination}` : 'Строка уедет в чужой отчёт'
          }
          description={
            <Typography.Text>
              {`Смена${item ? ` «${item.sourceLabel}»` : ''} вместе с показанием перейдёт в отчёт ${destination ? `«${destination}»` : 'того, кто по документу ехал'}: этот день её потеряет, приросты обеих машин пересчитаются, а если строка здесь последняя — отчёт будет аннулирован.`}
            </Typography.Text>
          }
        />

        <Form.Item
          name="reason"
          label="Причина переноса"
          rules={[{ required: true, message: 'Перенос чужого числа объясняют' }]}
          extra="Уедет в историю обоих отчётов: по ней потом отвечают, куда делась смена"
        >
          <Input.TextArea rows={2} maxLength={500} />
        </Form.Item>
      </Form>
    </FormModal>
  );
}
