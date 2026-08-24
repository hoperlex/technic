import { useState } from 'react';
import { Alert, Button, Card, Col, Input, InputNumber, Row, Select, Typography } from 'antd';
import { CloseOutlined, PlusOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import type { AutoPartDto, VehicleMaintenancePartDto } from '@technic/contracts';
import { useAutoPartCards } from '../model/useAutoPartCards';
import { SHOWN_DATE } from '../model/maintenanceText';
import {
  backdatedParts,
  movesText,
  newPartRow,
  partMoves,
  rowRaisesInactive,
  rowShortage,
  type PartRow,
} from '../model/parts';

/**
 * Блок «Автозапчасти» формы акта (план `docs/auto-parts-plan.md`, §8, Р5, Р7, Р19—Р21, Р24).
 *
 * Отдельной выдачи со склада нет: деталь списывается там, где фиксируется работа, — в акте
 * обслуживания. Отсюда три обещания блока, и все три про момент:
 *
 *   1. **Остаток меняется после сохранения всего акта**, а не построчно. Так и подписано: строки
 *      живут состоянием формы, и до нажатия «Сохранить» склад не двигается вовсе.
 *   2. **Итог будущей записи виден до нажатия** — «После сохранения: фильтр 12 → 11». Складское
 *      движение необратимо (журнал неизменяем, Р3), и узнавать о нём из ленты постфактум поздно.
 *   3. **Нехватка и акт задним числом — предупреждения, а не запреты.** Остаток проверяется под
 *      блокировкой в момент записи (Р7), а расход в старом акте бывает уже учтён в начальном
 *      остатке (Р20) — решает это человек, а не форма.
 *
 * Без права `autoParts.stock` блок виден, но только на чтение (Р19): акт правят ещё менеджер и
 * диспетчер, и номер документа им поправить надо, а склад двигают механики.
 */

const HEADER: Record<'name' | 'quantity' | 'note', string> = {
  name: 'Позиция',
  quantity: 'Количество',
  note: 'Примечание',
};

/** Как позиция называется в строке подбора: код дописывается, когда он есть (Р12). */
function partTitle(card: { name: string; code: string | null }): string {
  return card.code ? `${card.name} · ${card.code}` : card.name;
}

/** Остаток в строке подбора: число с единицей, ноль — красным. */
function stockTag(card: AutoPartDto) {
  return (
    <Typography.Text type={card.quantity > 0 ? 'secondary' : 'danger'} style={{ flexShrink: 0 }}>
      {card.quantity} {card.unit}
    </Typography.Text>
  );
}

/** Строки акта у того, кто склад не двигает: перечень без полей ввода. */
function ReadOnlyParts({ parts }: { parts: readonly VehicleMaintenancePartDto[] }) {
  if (parts.length === 0)
    return <Typography.Text type="secondary">Автозапчастей в акте нет</Typography.Text>;
  return (
    <>
      {parts.map((part) => (
        <Row key={part.id} gutter={8} style={{ marginBottom: 4 }}>
          <Col xs={24} sm={13}>
            {partTitle(part)}
          </Col>
          <Col xs={8} sm={4}>
            <Typography.Text strong>
              {part.quantity} {part.unit}
            </Typography.Text>
          </Col>
          <Col xs={16} sm={7}>
            <Typography.Text type="secondary">{part.note}</Typography.Text>
          </Col>
        </Row>
      ))}
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        Менять расход вправе механик: правка строк двигает склад, а не только документ
      </Typography.Text>
    </>
  );
}

export function MaintenancePartsBlock({
  vehicleId,
  rows,
  onChange,
  before,
  performedOn,
  canStock,
  recordParts,
  issue,
}: {
  vehicleId: string;
  rows: PartRow[];
  onChange: (rows: PartRow[]) => void;
  /** Что уже списано этим актом: из этого числа считается разница, а не из нуля (Р5). */
  before: Map<string, number>;
  /** Дата акта из формы — по ней предупреждают о двойном списании (Р20). `null` — не выбрана. */
  performedOn: string | null;
  canStock: boolean;
  /** Строки правимого акта как их отдал сервер: ими блок читается без права на склад. */
  recordParts: readonly VehicleMaintenancePartDto[];
  /**
   * Что мешает сохранить набор — уже после нажатия «Сохранить» (ADR 0094). Отказ живёт здесь, а не
   * тостом в углу: полем формы строку не пометить, но место ошибки назвать обязано окно.
   */
  issue: string | null;
}) {
  const [search, setSearch] = useState('');

  const ids = rows.map((row) => row.autoPartId).filter((id): id is string => id !== null);
  const { options, cards, loading } = useAutoPartCards({
    vehicleId,
    search,
    ids,
    enabled: canStock,
  });

  /*
   * Выбранная позиция обязана оставаться в списке, даже когда подбор её не вернул: она бывает
   * погашенной (Р24) и просто ушедшей со страницы под набранным поиском. Без этого строка теряла
   * бы подпись при первом же наборе в соседней строке.
   */
  const shown = [...options];
  for (const id of ids) {
    const card = cards.get(id);
    if (card && !shown.some((o) => o.id === card.id)) shown.push(card);
  }

  const moves = partMoves(rows, before, cards);
  const late = backdatedParts(rows, performedOn, cards);
  const change = (key: string, patch: Partial<PartRow>) =>
    onChange(rows.map((row) => (row.key === key ? { ...row, ...patch } : row)));

  return (
    <div style={{ marginBottom: 16 }}>
      {late.length > 0 && (
        // Предупреждение, а не запрет (Р20): свободу ввода задним числом заказчик выбрал прямо.
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 8 }}
          message="Проверьте расход: акт раньше даты заведения выбранной позиции"
          description={late
            .map(
              (card) =>
                `«${card.name}» заведена ${dayjs(card.createdAt).format(SHOWN_DATE)} — убедитесь, ` +
                'что этот расход не учтён в её начальном остатке.',
            )
            .join(' ')}
        />
      )}

      <Card
        size="small"
        title="Автозапчасти"
        extra={
          canStock && (
            <Button
              size="small"
              icon={<PlusOutlined />}
              onClick={() => onChange([...rows, newPartRow()])}
            >
              Добавить позицию
            </Button>
          )
        }
      >
        {!canStock ? (
          <ReadOnlyParts parts={recordParts} />
        ) : (
          <>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              Остаток изменится после сохранения всего акта
            </Typography.Text>

            {rows.length > 0 && (
              <Row gutter={8} style={{ marginTop: 8 }}>
                <Col xs={0} sm={12}>
                  <Typography.Text type="secondary">{HEADER.name}</Typography.Text>
                </Col>
                <Col xs={0} sm={4}>
                  <Typography.Text type="secondary">{HEADER.quantity}</Typography.Text>
                </Col>
                <Col xs={0} sm={7}>
                  <Typography.Text type="secondary">{HEADER.note}</Typography.Text>
                </Col>
              </Row>
            )}

            {rows.map((row) => {
              const card = row.autoPartId ? cards.get(row.autoPartId) : undefined;
              const short = rowShortage(row, before, card);
              const raisesInactive = rowRaisesInactive(row, before, card);
              return (
                <Row key={row.key} gutter={8} align="middle" style={{ marginTop: 8 }}>
                  <Col xs={24} sm={12}>
                    <Select
                      style={{ width: '100%' }}
                      showSearch
                      // Отбор и порядок — на сервере (Р21): свой фильтр молча резал бы подбор, а
                      // своя сортировка переставляла бы двадцать строк из полутора тысяч.
                      filterOption={false}
                      onSearch={setSearch}
                      onDropdownVisibleChange={(open) => !open && setSearch('')}
                      loading={loading}
                      value={row.autoPartId ?? undefined}
                      status={issue && row.autoPartId === null ? 'error' : undefined}
                      aria-label={HEADER.name}
                      placeholder="Наименование или код"
                      notFoundContent={
                        loading ? 'Ищем…' : 'Ничего не нашлось — проверьте написание'
                      }
                      onChange={(value: string) => change(row.key, { autoPartId: value })}
                      optionLabelProp="label"
                      options={shown.map((c) => ({
                        value: c.id,
                        label: (
                          <span
                            style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}
                          >
                            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>
                              {partTitle(c)}
                            </span>
                            {stockTag(c)}
                          </span>
                        ),
                      }))}
                    />
                  </Col>
                  <Col xs={7} sm={4}>
                    <InputNumber
                      style={{ width: '100%' }}
                      min={1}
                      precision={0}
                      status={
                        short === null && !raisesInactive && !(issue && row.quantity === null)
                          ? undefined
                          : 'error'
                      }
                      value={row.quantity}
                      aria-label={HEADER.quantity}
                      onChange={(v) => change(row.key, { quantity: v })}
                    />
                  </Col>
                  <Col xs={12} sm={7}>
                    <Input
                      maxLength={500}
                      value={row.note}
                      aria-label={HEADER.note}
                      placeholder="Зачем ставили"
                      onChange={(e) => change(row.key, { note: e.target.value })}
                    />
                  </Col>
                  <Col xs={5} sm={1} style={{ textAlign: 'right' }}>
                    <Button
                      type="text"
                      danger
                      icon={<CloseOutlined />}
                      aria-label={`Убрать позицию${card ? ` — ${card.name}` : ''}`}
                      onClick={() => onChange(rows.filter((r) => r.key !== row.key))}
                    />
                  </Col>
                  {card && (short !== null || raisesInactive) && (
                    <Col span={24}>
                      {/* Подсветка до отправки (Р7, Р24): отказ всё равно даёт сервер — остаток он
                          проверяет под блокировкой, и проверенное формой число к тому моменту
                          устареет. Портал лишь избавляет от заведомо пустого нажатия. */}
                      <Typography.Text type="danger" style={{ fontSize: 12 }}>
                        {raisesInactive
                          ? 'Позиция погашена — увеличить списание нельзя, уменьшить и снять можно'
                          : `На складе ${card.quantity} ${card.unit} — не хватает ${short}`}
                      </Typography.Text>
                    </Col>
                  )}
                </Row>
              );
            })}

            {rows.length === 0 && (
              <div style={{ marginTop: 8 }}>
                <Typography.Text type="secondary">
                  Позиции не заведены — акт можно сохранить и без расхода
                </Typography.Text>
              </div>
            )}

            {issue && (
              <div style={{ marginTop: 8 }}>
                <Typography.Text type="danger">{issue}</Typography.Text>
              </div>
            )}

            {moves.length > 0 && (
              // Итог словами, а не числом в углу: человек обязан увидеть движение ДО нажатия.
              <Alert
                type="success"
                showIcon
                style={{ marginTop: 12 }}
                message={`После сохранения: ${movesText(moves)}`}
              />
            )}
          </>
        )}
      </Card>
    </div>
  );
}
