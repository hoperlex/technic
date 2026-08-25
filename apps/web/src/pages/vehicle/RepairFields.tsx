import { Alert, Button, DatePicker, Form, Radio, Space, Typography } from 'antd';
import type { DriverDto, RepairPreviewDto } from '@technic/contracts';
import { AutoSelect } from '@shared/ui';
import dayjs from 'dayjs';
import { machinistOption } from './assignDriverHints';
import type { AssignmentSegment } from './assignmentTimeline';
import { formatDateOnly } from './shared';

/**
 * Поля окна «Починка истории» (подэтап 6a плана `docs/assignment-periods-plan.md`, Р29, Р31, Ц4).
 *
 * Отдельным файлом от окна: окно ведёт разговор, здесь только ввод. Правило у всех трёх разделов
 * одно и то же, что и у смены машиниста, — **портал не подставляет ни человека, ни границу**
 * (ADR 0083). Здесь оно даже строже: заполнение утверждает факт о прошлом, за которым выпишутся
 * бланки строгой отчётности задним числом, и подставленная фамилия уедет в них настоящей.
 */

/** Решение о машине после конца срока (Р31): какая из двух работает дальше. */
export function TailResolutionField({
  tail,
}: {
  tail: NonNullable<RepairPreviewDto['requiredVehicleResolution']>;
}) {
  return (
    <Form.Item
      name="tail"
      label="Чем заявка закрыта после конца срока"
      extra="Пока это не решено, срок продлить нельзя: листы выписались бы на машину истории, хотя работа и ставки относятся к машине назначения."
    >
      <Radio.Group>
        <Space direction="vertical" size={4}>
          <Radio value="assignment_wins">
            Дальше работает машина назначения — «{tail.assignmentVehicleName}»
          </Radio>
          <Radio value="history_wins">
            Дальше работает машина истории — «{tail.tailVehicleName}»; назначение и ставки
            переводятся на неё
          </Radio>
        </Space>
      </Radio.Group>
    </Form.Item>
  );
}

/**
 * Заполнение `unknown` известным человеком — по промежутку на раздел (Ц4).
 *
 * Границы предлагаются целым промежутком, но сужаются: половину истории восстанавливают сейчас,
 * половину — когда найдут документы. Правило «всё или ничего» отвергнуто по причине сильнее
 * простоты: оно толкает знающего половину вписать на вторую половину правдоподобное, а `unknown`
 * тем и ценен, что отличает «не знаем» от «знаем».
 */
export function KnownFillFields({
  gaps,
  machinists,
  loading,
}: {
  gaps: RepairPreviewDto['fillableGaps'];
  machinists: DriverDto[];
  loading: boolean;
}) {
  if (gaps.length === 0) return null;
  return (
    <Space direction="vertical" size={8} style={{ display: 'flex' }}>
      <Typography.Text strong>Кто работал в неизвестные дни</Typography.Text>
      <Alert
        type="info"
        showIcon
        message="За эти дни листов нет вовсе — они выпишутся задним числом"
        description="Дни закрыты: бумагу на них уже не отменить, и назвать человека можно только здесь. Как только он назван, портал выпишет недостающие бланки ЭСМ-2 на прошедшие даты — номера будут показаны до нажатия."
      />
      {gaps.map((gap) => (
        <Space key={gap.from} direction="vertical" size={4} style={{ display: 'flex' }}>
          <Space size={8} wrap align="end">
            {/* Тот же вопрос и та же подпись, что у якорей: человек отвечает на один вопрос — кто
              работал в эти дни, — а чем портал починит историю, решает не он. */}
            <Form.Item
              name={['fills', gap.from, 'personId']}
              label={`Кто работал ${formatDateOnly(gap.from)} — ${formatDateOnly(gap.to)}`}
              style={{ marginBottom: 0 }}
            >
              <AutoSelect
                autoSelectSole={false}
                options={machinists.map(machinistOption)}
                loading={loading}
                allowClear
                style={{ width: 260 }}
                placeholder="Не знаю — оставить как есть"
                notFoundContent="В справочнике нет действующих водителей"
              />
            </Form.Item>
            {/* Границы — внутри промежутка и только внутри: чужая граница приходит 422-м, и
              человек, сузивший окно на день, не понял бы, какой из отрезков сервер счёл чужим. */}
            <Form.Item name={['fills', gap.from, 'range']} noStyle>
              <DatePicker.RangePicker
                format="DD.MM.YYYY"
                allowClear={false}
                disabledDate={(d) => {
                  const key = d.format('YYYY-MM-DD');
                  return key < gap.from || key > gap.to;
                }}
                defaultValue={[dayjs(gap.from), dayjs(gap.to)]}
              />
            </Form.Item>
          </Space>
        </Space>
      ))}
    </Space>
  );
}

/**
 * Уже сделанные заполнения — и кнопка снять их (Ю2, Щ2).
 *
 * Снимает та же дверь, которая заполнила, но **другой командой**: «восстанавливаю» и «снимаю» —
 * разные утверждения, и выяснять, какое из них человек имел в виду, по составу тела нельзя. Отсюда
 * и отдельная кнопка вместо галочки в общей форме.
 */
export function KnownFillsMade({
  fills,
  driverName,
  onCancel,
  disabled,
}: {
  fills: { changeGroupId: string; segment: AssignmentSegment }[];
  driverName: (personId: string) => string | undefined;
  onCancel: (changeGroupId: string) => void;
  disabled: boolean;
}) {
  if (fills.length === 0) return null;
  return (
    <Space direction="vertical" size={8} style={{ display: 'flex' }}>
      <Typography.Text strong>Заполнено ранее</Typography.Text>
      {fills.map(({ changeGroupId, segment }) => {
        const personId = segment.driver?.state === 'set' ? segment.driver.personId : null;
        return (
          <Space key={changeGroupId} size={8} wrap>
            <Typography.Text>
              {formatDateOnly(segment.from)}
              {segment.to ? ` — ${formatDateOnly(segment.to)}` : ''}:{' '}
              {/* Имя берётся из справочника: строка истории носит состояние, а не человека. */}
              {personId ? (driverName(personId) ?? 'машинист не найден в справочнике') : '—'}
            </Typography.Text>
            <Button size="small" disabled={disabled} onClick={() => onCancel(changeGroupId)}>
              Отменить заполнение
            </Button>
          </Space>
        );
      })}
      <Typography.Text type="secondary">
        Отмена возвращает дни в «машинист неизвестен» — вместе с бумагой, которая была выписана по
        этому утверждению.
      </Typography.Text>
    </Space>
  );
}
