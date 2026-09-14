import { Space, Typography } from 'antd';
import type { EstimateMode, EstimateRow } from '../model/rows';
import { EstimateFreeFields, EstimateModeSwitch } from './EstimateFreeMode';
import { EstimateRowsGroup } from './EstimateRows';
import type { ServiceItemKind } from '@technic/contracts';

/**
 * СОСТАВ ОБЪЁМА РАБОТ НА ЭКРАНЕ: переключатель способа набора, сами поля и итог.
 *
 * Отдельным куском от окна потому, что целиком уходит с экрана у подачи счётом (Р10 плана
 * `docs/office-equipment-on-site-and-invoice-estimate-plan.md`): у документной ревизии строк нет
 * вовсе, и всё перечисленное — переключатель, графы, описание, стоимость, итог — в ней не
 * заполняют. Собранный в одном месте, он и убирается одним условием; разложенный по окну, он
 * оставил бы за собой то поле стоимости, о котором забыли.
 *
 * ПОЛЯ УБИРАЮТСЯ, А НЕ ГАСЯТСЯ, и это не вкусовщина: у окна уже есть настоящий погашенный режим —
 * замок висящего предъявления, — и означает он другое («сначала отзовите предъявление»). Два
 * состояния, выглядящих одинаково, отправили бы человека искать несуществующую кнопку.
 */
export function EstimateComposition({
  mode,
  rows,
  total,
  disabled = false,
  onSwitchMode,
  onAddRow,
  onChangeRow,
  onRemoveRow,
}: {
  mode: EstimateMode;
  rows: readonly EstimateRow[];
  /** Итог считается по тем же строкам, что уедут на сервер, — разойтись им нечем. */
  total: number;
  /** Правка закрыта висящим предъявлением (Р9). */
  disabled?: boolean;
  onSwitchMode: (next: EstimateMode) => void;
  onAddRow: (kind: ServiceItemKind) => void;
  onChangeRow: (key: string, patch: Partial<EstimateRow>) => void;
  onRemoveRow: (key: string) => void;
}) {
  const freeRow = rows[0];
  return (
    <>
      {/* Переключатель стоит НАД составом: он меняет то, что под ним, и решение о способе ввода
          принимают до набора, а не дочитав до итога. */}
      <Space size={8}>
        <Typography.Text type="secondary">Как набрать:</Typography.Text>
        <EstimateModeSwitch mode={mode} rows={rows} disabled={disabled} onChange={onSwitchMode} />
      </Space>

      {mode === 'free' && freeRow ? (
        <EstimateFreeFields
          row={freeRow}
          disabled={disabled}
          onChange={(patch) => onChangeRow(freeRow.key, patch)}
        />
      ) : (
        <>
          <EstimateRowsGroup
            kind="part"
            disabled={disabled}
            rows={rows.filter((row) => row.kind === 'part')}
            onAdd={onAddRow}
            onChange={onChangeRow}
            onRemove={onRemoveRow}
          />
          <EstimateRowsGroup
            kind="service"
            disabled={disabled}
            rows={rows.filter((row) => row.kind === 'service')}
            onAdd={onAddRow}
            onChange={onChangeRow}
            onRemove={onRemoveRow}
          />
        </>
      )}

      {/* Итог — строка, а не поле: его считает сумма строк, и разойтись с ней он не может. У подачи
          счётом его нет вовсе, и это не пропуск разметки: строк там ноль, а посчитанный по ним
          «0,00 ₽» читался бы как цена работ — ровно та ошибка, которую §8 плана велит вывести
          отовсюду, где сумма ещё неизвестна. */}
      <Space size={8} style={{ justifyContent: 'flex-end', width: '100%' }}>
        <Typography.Text type="secondary">Итого по объёму работ:</Typography.Text>
        <Typography.Text strong style={{ fontSize: 16 }}>
          {total.toLocaleString('ru-RU', {
            minimumFractionDigits: 2,
            maximumFractionDigits: 2,
          })}{' '}
          ₽
        </Typography.Text>
      </Space>
    </>
  );
}
