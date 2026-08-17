import { Tabs } from 'antd';
import { useReadingsAddress, type ReadingsSub } from './readingsAddress';
import { ReadingsIntakeTab } from './ReadingsIntakeTab';
import { ReadingsStatsTab } from './ReadingsStatsTab';

/**
 * Вкладка «Показания» с полосой подвкладок (план «Показания техники», Р1): «Приём» и «Статистика».
 *
 * Полоса появилась только теперь, и это то же решение, что и раньше: на этапе 2 подвкладка была
 * одна, а полоса из одной вкладки не даёт выбора — она его обещает. Разбор `?sub=` при этом завели
 * сразу, поэтому ссылки, разосланные до полосы, открывают ровно то же, что и открывали.
 *
 * **Показывается только выбранная подвкладка.** Обычные `Tabs` держат посещённую панель
 * смонтированной, а обе подвкладки отдают свою панель инструментов в один и тот же слот строки
 * вкладок (`TabsExtra tabKey="readings"`) — оставь их обе живыми, и после первого же переключения в
 * шапке висели бы два периода и две сводки сразу. Отсюда же и польза: реестр приёма не спрашивает
 * сервер, пока смотрят статистику.
 *
 * Своя полоса, а не вложенный `PageTabs`: тот заводит собственный слот и собственный «активный
 * ключ», и `TabsExtra` подвкладок начал бы сверяться с ним вместо ключа страницы — то есть панель
 * инструментов не показалась бы вовсе.
 */

const items: { key: ReadingsSub; label: string }[] = [
  { key: 'intake', label: 'Приём' },
  { key: 'stats', label: 'Статистика' },
];

export function ReadingsTab({ date }: { date: string }) {
  const { sub, setSub } = useReadingsAddress(date);

  return (
    <Tabs
      className="full-height-tabs"
      size="small"
      activeKey={sub}
      onChange={(key) => setSub(key as ReadingsSub)}
      items={items.map((item) => ({
        key: item.key,
        label: item.label,
        children:
          item.key !== sub ? null : item.key === 'intake' ? (
            <ReadingsIntakeTab date={date} />
          ) : (
            <ReadingsStatsTab date={date} />
          ),
      }))}
    />
  );
}
