import { Button, DatePicker, Space } from 'antd';
import { LeftOutlined, RightOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import { useSearchParams } from 'react-router';
import { useIsMobile } from '@shared/lib';
import { PageTabs } from '../components/PageTabs';
import { GarageVehiclesTab } from './garage/GarageVehiclesTab';
import { GarageDriversTab } from './garage/GarageDriversTab';

/**
 * Гараж (ADR 0076): чем заняты собственная техника и водители в конкретный день.
 *
 * **День общий у обеих вкладок и живёт на странице**, а не внутри них: смотрят один и тот же день
 * с двух сторон — «чем занята машина» и «кто за рулём», — и переключение вкладки, сбрасывающее
 * дату на сегодня, ломало бы ровно этот переход. Отсюда же адрес: `?tab=` и `?date=` переживают
 * перезагрузку и уходят ссылкой тому, кого зовут посмотреть на завтрашний день.
 */

const DATE = 'YYYY-MM-DD';

const TABS = ['vehicles', 'drivers'] as const;

export function GaragePage() {
  const isMobile = useIsMobile();
  const [sp, setSp] = useSearchParams();

  const raw = sp.get('tab') ?? '';
  const tab = (TABS as readonly string[]).includes(raw) ? raw : 'vehicles';

  // Умолчание — сегодня, и считается оно по часам браузера только для первого показа: отобранные
  // строки всё равно относятся к дню, который вернул сервер (`onDate`).
  const rawDate = sp.get('date') ?? '';
  const parsed = dayjs(rawDate, DATE, true);
  const day = parsed.isValid() ? parsed : dayjs();

  const go = (patch: { tab?: string; date?: dayjs.Dayjs }) =>
    setSp(
      {
        tab: patch.tab ?? tab,
        date: (patch.date ?? day).format(DATE),
      },
      // Перебор дней — не история переходов: «назад» должно возвращать на предыдущий экран, а не
      // отматывать по одному дню всё, что пролистали.
      { replace: true },
    );

  /**
   * Управление днём: стрелки на соседние сутки и «Сегодня». Смотрят чаще всего завтра и сегодня,
   * и попадать в календарь ради соседнего дня незачем.
   */
  const dayControls = (
    <Space size={4}>
      <Button
        icon={<LeftOutlined />}
        aria-label="Предыдущий день"
        onClick={() => go({ date: day.subtract(1, 'day') })}
      />
      <DatePicker
        format="DD.MM.YYYY"
        allowClear={false}
        inputReadOnly={isMobile}
        value={day}
        onChange={(v) => v && go({ date: v })}
      />
      <Button
        icon={<RightOutlined />}
        aria-label="Следующий день"
        onClick={() => go({ date: day.add(1, 'day') })}
      />
      <Button disabled={day.isSame(dayjs(), 'day')} onClick={() => go({ date: dayjs() })}>
        Сегодня
      </Button>
    </Space>
  );

  /**
   * Управление днём отдано вкладкам, а не строке вкладок: место справа от них занято сводкой
   * (`TabsExtra`), и второй `tabBarExtraContent` затёр бы её слот. Вкладка ставит день рядом со
   * своей сводкой — там же, где он уезжает под вкладки на телефоне.
   */
  const items = [
    {
      key: 'vehicles',
      label: 'Техника',
      children: <GarageVehiclesTab date={day.format(DATE)} dayControls={dayControls} />,
    },
    {
      key: 'drivers',
      label: 'Водители',
      children: <GarageDriversTab date={day.format(DATE)} dayControls={dayControls} />,
    },
  ];

  return (
    <div style={{ height: '100%' }}>
      <PageTabs
        activeKey={tab}
        onChange={(k) => go({ tab: k })}
        // Обе вкладки читают один и тот же день: переключение обновляет его данные целиком.
        refreshQueryKey={['garage']}
        items={items}
      />
    </div>
  );
}
