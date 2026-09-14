import { useState, type ReactNode } from 'react';
import { Alert, Select, Space, Typography } from 'antd';
import type { Permission } from '@technic/contracts';
import { useAuth } from '../../auth/AuthContext';
import { ReadingsExportTab } from './ReadingsExportTab';
import { AnalyticsExportTab } from './AnalyticsExportTab';

/**
 * Служебные выгрузки: одна вкладка на все книги портала
 * (`docs/analytics-summary-export-plan.md`, Р1).
 *
 * Реестр, а не вторая вкладка рядом с первой. Книг стало две, и обе отвечают на один и тот же
 * вопрос «выгрузить за период»; развёрнутые вкладками, они на третьей книге дали бы полосу
 * вкладок, в которой «Администрирование» уже не видно, а на четвёртой — кнопки, расползшиеся по
 * модулям. Тем же приёмом живёт реестр разделов портала (ADR 0121): одно место, куда добавляется
 * следующая запись.
 *
 * **Следующая выгрузка добавляется строкой в `EXPORTS` и больше нигде** — кроме строки в
 * `ADMIN_PAGE_PERMISSIONS`, без которой её право не открывало бы саму страницу.
 */

interface ExportEntry {
  key: string;
  label: string;
  /** Право книги. Своё у каждой: выгрузка выносит данные наружу, и выдают их порознь. */
  permission: Permission;
  /** На какой вопрос отвечает книга — строкой, до того как её начали собирать. */
  description: string;
  /**
   * Панель параметров. Готовым элементом, а не функцией: элементы неизменны, создаются один раз
   * при загрузке модуля и при переключении вида не заставляют React пересобирать поддерево.
   */
  panel: ReactNode;
}

const EXPORTS: ExportEntry[] = [
  {
    key: 'vehicle-readings',
    label: 'Показания автотранспорта',
    permission: 'vehicleReadings.export',
    description:
      'Пробег, наработка, топливо и смены по каждой машине парка за период — вместе с водителями и нареканиями.',
    panel: <ReadingsExportTab />,
  },
  {
    key: 'analytics-summary',
    label: 'Сводная аналитика по заказчикам',
    permission: 'analytics.export',
    description:
      'Работа заказа техники, вывоза мусора и механизации за период в разрезе «объект / отдел»: количества, деньги и инфографика по одной площадке.',
    panel: <AnalyticsExportTab />,
  },
];

export function ExportsTab() {
  const { can } = useAuth();
  // Право у каждой книги своё и ни одно не входит в ролевые наборы: человек с одним из них увидит
  // в списке ровно одну строку — и это не ошибка списка, а его честный ответ.
  const available = EXPORTS.filter((entry) => can(entry.permission));

  const [key, setKey] = useState<string | undefined>(available[0]?.key);
  const current = available.find((entry) => entry.key === key) ?? available[0];

  if (!current) {
    // Страница открывается любым правом выгрузки, но сама вкладка заводится только тогда, когда
    // хоть одна книга доступна. Ветка остаётся на случай, если гейт вкладки и реестр разойдутся:
    // пустая панель без слов читалась бы как поломка выгрузки.
    return (
      <div style={{ padding: 16 }}>
        <Alert
          type="info"
          showIcon
          title="Выгрузки вам не открыты"
          description="У каждой книги своё право, и ни одного из них у вас нет."
        />
      </div>
    );
  }

  return (
    <div style={{ height: '100%', overflow: 'auto' }}>
      <Space
        orientation="vertical"
        size={4}
        style={{ display: 'flex', padding: '16px 16px 0', maxWidth: 760 }}
      >
        <div>
          {/* Подпись рядом с полем, а не вокруг него: обёрнутая подпись вбирает в себя текст
              выбранного варианта, и «Вид выгрузки» перестаёт быть именем поля для всех, кто ищет
              его текстом, — от программы чтения с экрана до теста. */}
          <label htmlFor="export-kind" style={{ display: 'block', marginBottom: 4 }}>
            Вид выгрузки
          </label>
          <Select
            id="export-kind"
            value={current.key}
            onChange={setKey}
            style={{ width: '100%', maxWidth: 460 }}
            // Список показывается и тогда, когда выбирать не из чего, но выключенным: спрятать его
            // значило бы соврать, что выгрузка в портале одна, а оставить рабочим — предложить
            // выбор, которого нет. Выключенное поле вместе со строкой ниже отвечает на оба
            // вопроса: какая книга открыта и почему она одна.
            disabled={available.length < 2}
            options={available.map((entry) => ({ value: entry.key, label: entry.label }))}
          />
        </div>
        <Typography.Text type="secondary">{current.description}</Typography.Text>
        {available.length < EXPORTS.length && (
          <Typography.Text type="secondary">
            Выгрузок в портале {EXPORTS.length}, вам доступно: {available.length}. У каждой своё
            право, и выдают их порознь — «видна одна» здесь не поломка списка, а его ответ.
          </Typography.Text>
        )}
      </Space>
      {current.panel}
    </div>
  );
}
