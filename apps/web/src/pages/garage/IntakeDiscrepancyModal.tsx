import { Alert, Form, Input, Radio, Space, Typography } from 'antd';
import type {
  DiscrepancyResolution,
  DriverReportDto,
  ReportDiscrepancyDto,
} from '@technic/contracts';
import { vehicleReadingsApi } from '@entities/vehicle-reading';
import { FormModal } from '@shared/ui';
import { useIntakeAction } from './intakeAction';

/**
 * Решение по расхождению (ADR 0103, решение 10; план «Показания техники», Р7).
 *
 * Расхождения не хранятся — хранятся решения по ним, и действует последнее. Отсюда устройство окна.
 *
 * 1. **Само расхождение объясняет сервер.** Его фраза («рейс Р-142 переназначен Петрову П. П.»)
 *    стоит здесь целиком и не пересказывается: у портала нет ни имени нового работника, ни прежней
 *    даты рейса, и вывести объяснение из вида расхождения он не может.
 * 2. **Прежнее решение видно рядом с новым.** Журнал append-only: запись не правится, а
 *    перекрывается следующей — поэтому «изменить решение» здесь такая же форма, как первый разбор,
 *    и в ней показано, что действует сейчас.
 * 3. **Отпечаток уходит обратно нетронутым.** Решение действует, пока сравниваемые поля те же;
 *    сервер сверит отпечаток и отвергнет разбор того, чего человек уже не видел.
 *
 * Исходы портал называет сам — это выбор действия, а не объяснение расхождения: контракт даёт их
 * кодами (`DISCREPANCY_RESOLUTIONS`), а подпись кнопки выбора обязана говорить, что случится.
 */

interface Choice {
  value: DiscrepancyResolution;
  label: string;
  hint: string;
}

const ACCEPT_AS_IS: Choice = {
  value: 'accepted_as_is',
  label: 'Признать допустимым',
  hint: 'Снимок остаётся как есть, расхождение перестаёт держать приём дня',
};

/** Добавить недостающий выезд можно только там, где его не хватает: остальным сервер откажет. */
const ADD_SOURCE: Choice = {
  value: 'source_added',
  label: 'Добавить выезд в отчёт',
  hint: 'В отчёте появится строка ожидания по этому выезду — показание по ней ещё ждут',
};

const REVOKE: Choice = {
  value: 'revoked',
  label: 'Отменить прежнее решение',
  hint: 'Расхождение снова станет неразобранным и снова задержит приём дня',
};

const CONFLICT =
  'Решение не записано: отчёт или само расхождение изменились, пока карточка была открыта. ' +
  'Она перечитана — посмотрите, что стало другим, и разберите заново';

export function IntakeDiscrepancyModal({
  report,
  discrepancy,
  onClose,
}: {
  /** Отчёт целиком: из него берётся версия шапки — оптимистическая блокировка разбора. */
  report: DriverReportDto;
  discrepancy: ReportDiscrepancyDto;
  onClose: () => void;
}) {
  const [form] = Form.useForm<{ resolution: DiscrepancyResolution; reason: string }>();

  const choices = [
    ...(discrepancy.kind === 'missing_source' ? [ADD_SOURCE] : []),
    ACCEPT_AS_IS,
    // Отменять нечего там, где решения ещё не было: `revoked` существует ради возврата уже
    // разобранного в неразобранное при неизменном отпечатке.
    ...(discrepancy.resolved ? [REVOKE] : []),
  ];

  const resolve = useIntakeAction({
    run: (values: { resolution: DiscrepancyResolution; reason: string }) =>
      vehicleReadingsApi.resolveDiscrepancy(report.id, {
        kind: discrepancy.kind,
        // Предмет решения — строка ожидания либо (у `missing_source`) сам источник: журнал решений
        // ведётся по предмету, и подменять его порталом нечем.
        itemId: discrepancy.itemId,
        sourceKind: discrepancy.sourceKind,
        sourceId: discrepancy.sourceId,
        fingerprint: discrepancy.fingerprint,
        resolution: values.resolution,
        reason: values.reason.trim(),
        version: report.version,
      }),
    done: 'Решение записано',
    conflict: CONFLICT,
    onDone: onClose,
  });

  return (
    <FormModal
      title={discrepancy.resolved ? 'Изменить решение' : 'Разобрать расхождение'}
      open
      onCancel={onClose}
      onSubmit={() => form.submit()}
      confirmLoading={resolve.isPending}
      okText="Записать решение"
      width={560}
    >
      <Form
        form={form}
        layout="vertical"
        initialValues={{ resolution: choices[0]!.value, reason: '' }}
        onFinish={(values) => resolve.mutate(values)}
      >
        {/* Текст расхождения — серверный и целиком (Р7): портал своих слов сюда не сочиняет. */}
        <Alert type="warning" showIcon message={discrepancy.message} style={{ marginBottom: 16 }} />

        {/* Действует последнее решение, а не первое: что стоит сейчас — видно до того, как его
            заменят. Иначе «изменить» означало бы менять неизвестно что. */}
        {discrepancy.resolved && (
          <Typography.Paragraph type="secondary">
            {`Сейчас действует: разобрано — ${discrepancy.resolvedReason || 'без причины'}`}
          </Typography.Paragraph>
        )}

        <Form.Item name="resolution" label="Что делаем">
          <Radio.Group>
            <Space direction="vertical" size={8}>
              {choices.map((choice) => (
                <Radio key={choice.value} value={choice.value}>
                  <Space direction="vertical" size={0}>
                    <span>{choice.label}</span>
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                      {choice.hint}
                    </Typography.Text>
                  </Space>
                </Radio>
              ))}
            </Space>
          </Radio.Group>
        </Form.Item>

        {/* Причина обязательна у всякого решения: по ней потом отвечают, почему день приняли с
            расхождением, — и она же остаётся в журнале, когда решение перекроют следующим. */}
        <Form.Item
          name="reason"
          label="Причина решения"
          rules={[{ required: true, message: 'Назовите причину: по ней потом отвечают' }]}
          extra="Останется в журнале решений: он append-only, и прежняя запись никуда не денется"
        >
          <Input.TextArea rows={2} maxLength={500} />
        </Form.Item>
      </Form>
    </FormModal>
  );
}
