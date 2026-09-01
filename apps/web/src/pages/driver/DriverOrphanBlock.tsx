import { Fragment, useState } from 'react';
import { Alert, Button, Radio, Space, Typography } from 'antd';
import { ViewModal } from '@shared/ui';
import { formatDateTime } from '../../utils/format';
import type { DraftItem } from './api';

/**
 * Блок «Введено, но не привязано к строке» (план кабинета водителя, Р14).
 *
 * Показывается, когда ключ записи черновика не сопоставился ни с одной строкой отчёта: рейс
 * переназначили другому водителю, `itemId` сменился между сохранением и открытием, запись пришла
 * из прежнего формата черновика. Отбросить такую запись нельзя — она единственная копия того, что
 * человек ввёл, — а угадать, к какому рейсу относились цифры, портал не имеет права. Отсюда всё
 * устройство блока: числа, комментарий и дата сохранения показываются целиком, кнопки отправки нет
 * вовсе, а привязывает запись человек нажатием.
 *
 * Своего состояния, кроме выбора цели в открытом окне переноса, у блока нет: показанное живёт в
 * черновике страницы, и второй его копии быть не должно.
 */

/** Подписи блока — той же величины, что и подсказки формы (план типографики, Р6). */
const hintStyle = { fontSize: '0.9em' } as const;
const DASH = '—';

/** Незаполненное поле показывается прочерком, а не пропускается: «не введено» — тоже сведение. */
const withUnit = (value: string, unit: string): string => (value ? `${value} ${unit}` : DASH);

/**
 * Поля показания одним списком — и для показа, и для сравнения «сейчас / станет». Разойдись они,
 * сравнение молчало бы ровно о том поле, которое забыли дописать, и замену человек подтверждал бы
 * вслепую (Р14а п. 2).
 *
 * Файлы стоят числом, а не списком имён: переносятся они целиком, вместе со всем остальным, и
 * разглядывать снимки по одному здесь незачем — блок про то, что введённое не пропало.
 */
const FIELDS: { label: string; text: (item: DraftItem) => string }[] = [
  { label: 'Одометр', text: (item) => withUnit(item.odometerKm, 'км') },
  { label: 'Моточасы', text: (item) => withUnit(item.engineHours, 'ч') },
  { label: 'Заправлено', text: (item) => withUnit(item.fuelFilledLiters, 'л') },
  { label: 'Комментарий', text: (item) => item.comment || DASH },
  { label: 'Файлы', text: (item) => (item.files.length > 0 ? String(item.files.length) : DASH) },
];

/** Куда переносить: строка дня, открытую правку которой водитель имеет (Р14а п. 1). */
export interface TransferTarget {
  /** Ключ строки черновика — `sourceKind:sourceId` (Р11): им же страница и запишет перенесённое. */
  key: string;
  /** Чем строка называется на экране: «Рейс Р-142 · КамАЗ 65115». */
  label: string;
  /** Что в этой строке уже введено, если введено: занятую цель молча не перезаписывают. */
  occupied: DraftItem | null;
}

/**
 * Чем перенос кончился для цели: пустая приняла его сразу, занятая — заменой. Различие нужно не
 * блоку, а владельцу черновика: файлы, вытесненные заменой, он удаляет из хранилища тем же
 * вызовом, что и при ручном удалении, — до отправки они ещё ничьи, и сиротами им лежать незачем
 * (Р14а п. 3).
 */
export type TransferMode = 'empty' | 'replace';

export interface OrphanBlockProps {
  /** Введённое, потерявшее свою строку: показывается целиком, отправить его нечем (Р14). */
  item: DraftItem;
  /** Когда сохранено — физическое время черновика (`DraftEntry.savedAt`), а не логические часы. */
  savedAt: number;
  /**
   * Откуда запись взялась: «строка ушла из задания», «введено в прежней версии». Знает это
   * страница — она сопоставляла ключи, — и блок текст не выдумывает.
   */
  origin?: string;
  /**
   * Куда переносить разрешено. Ноль целей — кнопки нет вовсе, а блок остаётся на экране: числа
   * нужны, чтобы продиктовать их диспетчеру (Р14а п. 1).
   */
  targets: readonly TransferTarget[];
  /**
   * Человек выбрал: вот строка-цель и вот чем перенос для неё кончится. Саму запись блок не
   * делает намеренно — порядок «собрать → записать черновик → обновить состояние → удалить
   * вытесненные файлы» принадлежит владельцу черновика, а не блоку ввода (Р14а п. 5): значение
   * цели и надгробие источника уезжают одной правкой ветки (Р11г), а файлы удаляются только после
   * её успеха. Знай этот порядок блок — он решал бы за страницу, что делать при отказе хранилища,
   * и делал бы это, не имея ни ветки, ни отметок удаления.
   */
  onTransfer: (targetKey: string, mode: TransferMode) => void;
}

/** Поля показания подписью и значением — тем же списком, что и сравнение. */
function FieldRows({ item }: { item: DraftItem }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '4px 12px' }}>
      {FIELDS.map((field) => (
        <Fragment key={field.label}>
          <Typography.Text type="secondary" style={hintStyle}>
            {field.label}
          </Typography.Text>
          <Typography.Text>{field.text(item)}</Typography.Text>
        </Fragment>
      ))}
    </div>
  );
}

/**
 * Сравнение «сейчас / станет» по всем полям сразу. По всем — потому что перенос идёт целиком, а не
 * по полям: смешивать два показания нельзя, получилось бы число, которого никто не вводил
 * (Р14а п. 3).
 */
function Comparison({ current, next }: { current: DraftItem; next: DraftItem }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'auto 1fr 1fr', gap: '4px 12px' }}>
      <span />
      <Typography.Text type="secondary" style={hintStyle}>
        Сейчас
      </Typography.Text>
      <Typography.Text type="secondary" style={hintStyle}>
        Станет
      </Typography.Text>
      {FIELDS.map((field) => (
        <Fragment key={field.label}>
          <Typography.Text type="secondary" style={hintStyle}>
            {field.label}
          </Typography.Text>
          <Typography.Text type="secondary">{field.text(current)}</Typography.Text>
          <Typography.Text strong>{field.text(next)}</Typography.Text>
        </Fragment>
      ))}
    </div>
  );
}

export function OrphanBlock({ item, savedAt, origin, targets, onTransfer }: OrphanBlockProps) {
  const [choosing, setChoosing] = useState(false);
  const [chosenKey, setChosenKey] = useState<string | null>(null);
  // Единственная цель выбора не требует. Выбранная берётся из списка заново, а не хранится
  // объектом: состав целей меняется и под открытым окном — соседняя вкладка успевает заполнить
  // строку, а отчёт — уехать в принятые.
  const single = targets.length === 1 ? targets[0]! : null;
  const target = targets.find((entry) => entry.key === chosenKey) ?? single;

  const start = () => {
    // Пустая единственная цель принимает перенос сразу: спрашивать «в ту ли строку», когда строка
    // одна и в ней ничего нет, значит спрашивать ни о чём (Р14а п. 2).
    if (single && !single.occupied) {
      onTransfer(single.key, 'empty');
      return;
    }
    setChosenKey(single?.key ?? null);
    setChoosing(true);
  };

  const confirm = () => {
    if (!target) return;
    onTransfer(target.key, target.occupied ? 'replace' : 'empty');
    setChoosing(false);
  };

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
        padding: 12,
        border: '1px solid rgba(0, 0, 0, 0.06)',
        borderRadius: 8,
      }}
    >
      <div>
        <Typography.Text strong>Введено, но не привязано к строке</Typography.Text>
        {origin && (
          <div>
            <Typography.Text type="secondary" style={hintStyle}>
              {origin}
            </Typography.Text>
          </div>
        )}
      </div>

      <FieldRows item={item} />

      <Typography.Text type="secondary" style={hintStyle}>
        Сохранено {formatDateTime(new Date(savedAt).toISOString())}
      </Typography.Text>

      {targets.length === 0 ? (
        // Кнопки нет вовсе, а не выключенной: переносить в строку принятого или аннулированного
        // дня нельзя — запись пропала бы как «сопоставленная», а показать её было бы уже нечем.
        <Alert
          type="info"
          showIcon
          title="Перенести некуда"
          description="Ни одна строка этого дня не открыта для правки. Числа никуда не денутся — продиктуйте их диспетчеру."
        />
      ) : (
        <Button onClick={start}>Перенести</Button>
      )}

      <ViewModal
        title="Перенести в строку"
        open={choosing}
        onClose={() => setChoosing(false)}
        width={520}
        destroyOnHidden
        footer={[
          <Button key="cancel" onClick={() => setChoosing(false)}>
            Отмена
          </Button>,
          <Button key="ok" type="primary" disabled={!target} onClick={confirm}>
            {target?.occupied ? 'Заменить' : 'Перенести'}
          </Button>,
        ]}
      >
        <Space orientation="vertical" size={12} style={{ display: 'flex' }}>
          {targets.length > 1 && (
            <Radio.Group
              value={target?.key ?? null}
              onChange={(e) => setChosenKey(e.target.value as string)}
            >
              <Space orientation="vertical">
                {targets.map((entry) => (
                  <Radio key={entry.key} value={entry.key}>
                    {entry.label}
                    {entry.occupied ? ' — уже заполнена' : ''}
                  </Radio>
                ))}
              </Space>
            </Radio.Group>
          )}
          {target?.occupied && (
            <>
              <Alert
                type="warning"
                showIcon
                title="В этой строке уже есть введённое"
                description="Перенос заменит его целиком, вместе с файлами. Подтверждение аномалии придётся поставить заново: подтверждают показанное, а показывают его после переноса."
              />
              <Comparison current={target.occupied} next={item} />
            </>
          )}
        </Space>
      </ViewModal>
    </div>
  );
}
