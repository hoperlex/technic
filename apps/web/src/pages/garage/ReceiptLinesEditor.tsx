import type { KeyboardEvent, ReactNode } from 'react';
import { Button, Col, Input, InputNumber, Row, Select, Typography } from 'antd';
import { DeleteOutlined, PlusOutlined } from '@ant-design/icons';
import { useQuery } from '@tanstack/react-query';
import { RECEIPT_MAX_AMOUNT, RECEIPT_MAX_QUANTITY, vehicleOptionLabel } from '@technic/contracts';
import { ownVehicleKeys } from '@entities/auto-part-receipt';
import { DICTIONARY_PAGE_SIZE } from '@shared/config';
import { useIsMobile } from '@shared/lib';
import { vehiclesApi } from '../../api/resources';
import type { ReceiptLineErrors, ReceiptLineRow } from './receiptLines';

/**
 * Таблица строк в окне «Принять чек» (план `docs/auto-part-receipts-plan.md`, §8, Р7—Р10).
 *
 * Строка чека — это шесть полей и ни одного справочника: наименование набирается дословно, как
 * напечатано в чеке (Р7), единица — текст с умолчанием «шт» (Р10). Справочник номенклатуры
 * потребовал бы завести позицию **до** ввода чека, то есть вернул бы ровно ту работу, которую этим
 * выпуском снимают.
 *
 * Строки живут состоянием формы, а не `Form.List`, по той же причине, что и состав объёма работ у
 * заявки: итог пересчитывается на каждое нажатие клавиши и стоит тут же под таблицей — а это
 * главное, что окно делает. Отсюда и отказы: их показывает не `Form.Item`, а сама ячейка (§7 —
 * сервер присылает путь `lines.2.vehicleId` именно для этого).
 *
 * Отдельным файлом от формы заранее: растёт здесь — раскладка, подсказки, поведение полей, — а
 * бюджет длины один на файл (`apps/web/quality-budget.json`).
 */

/** Ширины ячеек на десктопе: сумма долей ровно 24, поэтому строка не переносится. */
const SPAN = {
  vehicle: 5,
  name: 6,
  quantity: 3,
  unit: 2,
  amount: 3,
  note: 4,
  remove: 1,
} as const;

/** То же на телефоне: техника и наименование по строке, числа втроём, примечание с кнопкой. */
const MOBILE_SPAN = {
  vehicle: 24,
  name: 24,
  quantity: 8,
  unit: 8,
  amount: 8,
  note: 20,
  remove: 4,
} as const;

/**
 * Перечень собственной техники для поля строки.
 *
 * Ключ и запрос — те же, что у отбора вкладки (`ownVehicleKeys.options()`): список один, и второй
 * запрос за ним означал бы вторую копию в кэше, переживающую переименование машины.
 *
 * Только `own`: строка чека ссылается на собственную машину, и это правило сервера (Р21), а не
 * подбора в форме, — прямой запрос к API прошёл бы мимо любого фильтра списка. Списанные и стоящие
 * в ремонте не убираются: чек законно выписан на машину, которую позже вывели из парка.
 */
function useOwnVehicleOptions(): { options: { value: string; label: string }[]; loading: boolean } {
  const { data, isFetching } = useQuery({
    queryKey: ownVehicleKeys.options(),
    queryFn: () =>
      vehiclesApi.list({
        page: 1,
        pageSize: DICTIONARY_PAGE_SIZE,
        ownership: 'own',
        sortBy: 'createdAt',
      }),
  });
  const options = (data?.items ?? [])
    .map((v) => ({ value: v.id, label: vehicleOptionLabel(v) }))
    // Порядок — по подписи: машину ищут глазами по госномеру, а не по дате заведения.
    .sort((a, b) => a.label.localeCompare(b.label, 'ru'));
  return { options, loading: isFetching };
}

/** Причина отказа под ячейкой: то же место и тот же цвет, что у подстрочника `Form.Item`. */
function CellError({ text }: { text?: string }) {
  if (!text) return null;
  return (
    <Typography.Text type="danger" style={{ fontSize: 12 }}>
      {text}
    </Typography.Text>
  );
}

/** Подписи столбцов на десктопе: на телефоне их заменяют плейсхолдеры — колонок там нет. */
function HeaderCell({ span, children }: { span: number; children: ReactNode }) {
  return (
    <Col sm={span}>
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        {children}
      </Typography.Text>
    </Col>
  );
}

/**
 * Дробное количество поле не принимает вовсе (Р10): разделитель гасится на нажатии, а не
 * округляется потом. `precision={0}` здесь был бы хуже отказа — он молча превратил бы «2,5» в «3»,
 * то есть переписал бы чек за механика. Прилетевшее вставкой дробное ловит проверка формы и
 * называет причину словами.
 */
function blockFraction(e: KeyboardEvent<HTMLInputElement>): void {
  if ([',', '.', 'e', 'E', '+', '-'].includes(e.key)) e.preventDefault();
}

export interface ReceiptLinesEditorProps {
  rows: readonly ReceiptLineRow[];
  /** Отказы по ячейкам: свои проверки формы и ответ сервера ложатся сюда одинаково. */
  errors: ReceiptLineErrors;
  /** Форма занята сохранением: поля гасятся, чтобы набранное не разъехалось с отправленным. */
  disabled?: boolean;
  onChange: (key: string, patch: Partial<ReceiptLineRow>) => void;
  onAdd: () => void;
  onRemove: (key: string) => void;
}

export function ReceiptLinesEditor({
  rows,
  errors,
  disabled = false,
  onChange,
  onAdd,
  onRemove,
}: ReceiptLinesEditorProps) {
  const isMobile = useIsMobile();
  const { options, loading } = useOwnVehicleOptions();

  return (
    <div>
      {!isMobile && rows.length > 0 && (
        <Row gutter={8} style={{ marginBottom: 4 }}>
          <HeaderCell span={SPAN.vehicle}>Техника</HeaderCell>
          <HeaderCell span={SPAN.name}>Наименование</HeaderCell>
          <HeaderCell span={SPAN.quantity}>Кол-во</HeaderCell>
          <HeaderCell span={SPAN.unit}>Ед.</HeaderCell>
          <HeaderCell span={SPAN.amount}>Сумма, ₽</HeaderCell>
          <HeaderCell span={SPAN.note}>Примечание</HeaderCell>
          <HeaderCell span={SPAN.remove}> </HeaderCell>
        </Row>
      )}

      {rows.length === 0 && (
        <Typography.Text type="secondary">
          Строк нет: перепишите позиции из чека — по ним считается его сумма
        </Typography.Text>
      )}

      {rows.map((row) => {
        const issue = errors[row.key] ?? {};
        return (
          <Row
            key={row.key}
            gutter={8}
            align="top"
            style={{
              marginTop: 8,
              // На телефоне поля строки идут в столбик, и без черты соседние чеки сливаются.
              ...(isMobile ? { borderTop: '1px solid rgba(0,0,0,0.06)', paddingTop: 8 } : {}),
            }}
          >
            <Col xs={MOBILE_SPAN.vehicle} sm={SPAN.vehicle}>
              {/* Пусто — «не отнесено» (Р8): общий инструмент и расходники гаража законно живут
                  строкой без машины, и очистка поля не отказ, а ответ. */}
              <Select
                style={{ width: '100%' }}
                allowClear
                showSearch
                optionFilterProp="label"
                placeholder="Не отнесено"
                aria-label="Техника строки"
                disabled={disabled}
                loading={loading}
                options={options}
                status={issue.vehicleId ? 'error' : undefined}
                value={row.vehicleId ?? undefined}
                onChange={(v: string | undefined) => onChange(row.key, { vehicleId: v ?? null })}
              />
              <CellError text={issue.vehicleId} />
            </Col>

            <Col xs={MOBILE_SPAN.name} sm={SPAN.name}>
              <Input
                maxLength={300}
                placeholder="Как в чеке"
                aria-label="Наименование"
                disabled={disabled}
                status={issue.name ? 'error' : undefined}
                value={row.name}
                onChange={(e) => onChange(row.key, { name: e.target.value })}
              />
              <CellError text={issue.name} />
            </Col>

            <Col xs={MOBILE_SPAN.quantity} sm={SPAN.quantity}>
              <InputNumber
                style={{ width: '100%' }}
                min={1}
                max={RECEIPT_MAX_QUANTITY}
                step={1}
                placeholder="Кол-во"
                aria-label="Количество"
                disabled={disabled}
                status={issue.quantity ? 'error' : undefined}
                value={row.quantity}
                onKeyDown={blockFraction}
                onChange={(v) => onChange(row.key, { quantity: v })}
              />
              <CellError text={issue.quantity} />
            </Col>

            <Col xs={MOBILE_SPAN.unit} sm={SPAN.unit}>
              <Input
                maxLength={20}
                placeholder="шт"
                aria-label="Единица"
                disabled={disabled}
                status={issue.unit ? 'error' : undefined}
                value={row.unit}
                onChange={(e) => onChange(row.key, { unit: e.target.value })}
              />
              <CellError text={issue.unit} />
            </Col>

            <Col xs={MOBILE_SPAN.amount} sm={SPAN.amount}>
              {/* Вводится сумма строки, а не цена (Р9): в чеке напечатана она, а цену за единицу
                  посчитает сервер делением — иначе «3 × 416,67» разошлось бы с бумагой. */}
              <InputNumber
                style={{ width: '100%' }}
                min={0}
                max={RECEIPT_MAX_AMOUNT}
                step={0.01}
                precision={2}
                placeholder="Сумма"
                aria-label="Сумма строки"
                disabled={disabled}
                status={issue.amount ? 'error' : undefined}
                value={row.amount}
                onChange={(v) => onChange(row.key, { amount: v })}
              />
              <CellError text={issue.amount} />
            </Col>

            <Col xs={MOBILE_SPAN.note} sm={SPAN.note}>
              <Input
                maxLength={500}
                placeholder="Примечание"
                aria-label="Примечание строки"
                disabled={disabled}
                value={row.note}
                onChange={(e) => onChange(row.key, { note: e.target.value })}
              />
            </Col>

            <Col xs={MOBILE_SPAN.remove} sm={SPAN.remove} style={{ textAlign: 'right' }}>
              <Button
                type="text"
                danger
                icon={<DeleteOutlined />}
                aria-label="Убрать строку"
                disabled={disabled}
                onClick={() => onRemove(row.key)}
              />
            </Col>
          </Row>
        );
      })}

      <Button
        type="link"
        size="small"
        icon={<PlusOutlined />}
        style={{ paddingInlineStart: 0, marginTop: 8 }}
        disabled={disabled}
        onClick={onAdd}
      >
        Добавить строку
      </Button>
    </div>
  );
}
