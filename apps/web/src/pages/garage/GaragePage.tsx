import { lazy } from 'react';
import { Button, DatePicker, Space } from 'antd';
import { LeftOutlined, RightOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import { useSearchParams } from 'react-router';
import { useIsMobile } from '@shared/lib';
import { garageKeys } from '@entities/garage';
import { useAuth } from '@entities/session';
import { PageTabs } from '@shared/ui';
import { readingsSub } from './readingsAddress';

const GarageVehiclesTab = lazy(() =>
  import('./GarageVehiclesTab').then((module) => ({ default: module.GarageVehiclesTab })),
);
const GarageDriversTab = lazy(() =>
  import('./GarageDriversTab').then((module) => ({ default: module.GarageDriversTab })),
);
const ReadingsTab = lazy(() =>
  import('./ReadingsTab').then((module) => ({ default: module.ReadingsTab })),
);
const AutoPartsTab = lazy(() =>
  import('./AutoPartsTab').then((module) => ({ default: module.AutoPartsTab })),
);

/**
 * Garage (ADR 0076): the daily occupation of owned vehicles and drivers.
 *
 * The page owns one shared day for both snapshot tabs: vehicle occupation and who is driving
 * answer two sides of the same question. Resetting to today on a tab switch would break that
 * comparison. The tab/date URL parameters survive reloads and can be sent to someone looking
 * at the same future day.
 *
 * There are four tabs, but the snapshot day belongs only to the first two. Readings has its own
 * period (ADR 0103), as do receipt-based auto parts (docs/auto-part-receipts-plan.md, §8).
 * Both preserve ?date= untouched, so returning to Vehicles shows the day the user left.
 */

const DATE = 'YYYY-MM-DD';

const TABS = ['vehicles', 'drivers', 'readings', 'parts'] as const;

export function GaragePage() {
  const isMobile = useIsMobile();
  const { can } = useAuth();
  const [sp, setSp] = useSearchParams();

  // Readings belong to their own permission: everyone admitted to Garage sees the daily snapshot,
  // but only reading-authorized users see vehicle measurements (R34).
  const canReadReadings = can('vehicleReadings.read');

  const raw = sp.get('tab') ?? '';
  const known =
    (TABS as readonly string[]).includes(raw) && (raw !== 'readings' || canReadReadings);
  const tab = known ? raw : 'vehicles';

  // The browser's today is only the initial default; returned rows still belong to the server's
  // onDate snapshot.
  const rawDate = sp.get('date') ?? '';
  const parsed = dayjs(rawDate, DATE, true);
  const day = parsed.isValid() ? parsed : dayjs();

  /**
   * Readings owns its sub-tab strip and selection (R1), alongside period, vehicle-card and report
   * keys. The page only reads the sub-key to preserve it while stepping through days.
   */
  const sub = readingsSub(sp);

  const go = (patch: { tab?: string; date?: dayjs.Dayjs }) => {
    // Patch existing parameters rather than replacing them: readings owns sub/from/to/vehicle,
    // and replacing the query would erase its period on every day step, changing the interval
    // shown when the user returns.
    const next = new URLSearchParams(sp);
    const nextTab = patch.tab ?? tab;
    next.set('tab', nextTab);
    next.set('date', (patch.date ?? day).format(DATE));
    // Name a sub-tab only where one exists; on Vehicles the sub key would describe no real control.
    if (nextTab === 'readings') next.set('sub', sub);
    else next.delete('sub');

    // Day browsing is not navigation history: Back returns to the previous screen instead of
    // replaying every inspected day. The existing tab switch shares this replace policy.
    setSp(next, { replace: true });
  };

  /**
   * Day arrows and Today avoid opening a calendar for the most common adjacent-day comparison.
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
   * Tabs own the day controls because TabsExtra already uses the strip's right-hand slot for
   * summary counts; another tabBarExtraContent would overwrite it. Each tab puts the day beside
   * its summary, with both moving below the strip on phones.
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
    // Both readings sub-tabs use periods, not a snapshot day (ADR 0103, R27, R29). Day controls
    // therefore stay with the two tabs that actually answer a daily question.
    ...(canReadReadings
      ? [
          {
            key: 'readings',
            label: 'Показания',
            children: <ReadingsTab date={day.format(DATE)} />,
          },
        ]
      : []),
    /*
     * Auto-part receipts are the fourth tab after Readings (docs/auto-part-receipts-plan.md, R1).
     * Its URL key and label stay unchanged: the subject became receipt purchases rather than
     * warehouse stock, but existing ?tab=parts bookmarks and messages must still reach it.
     *
     * Receipts have their own period (§8): amounts are read over months or years, not on a
     * snapshot date, so the common day picker would ask the wrong question here.
     *
     * No separate tab grant: anyone admitted to Garage may read receipts (R5), since both
     * dispatchers and managers need to know whether parts were bought for a vehicle. Only
     * actions require autoParts.manage or autoParts.delete; the list itself does not.
     */
    { key: 'parts', label: 'Автозапчасти', children: <AutoPartsTab /> },
  ];

  return (
    <div style={{ height: '100%' }}>
      <PageTabs
        activeKey={tab}
        onChange={(k) => go({ tab: k })}
        // The root covers the day slice only — "Техника" and "Водители"; "Показания" and
        // "Автозапчасти" ask their own keys about their own periods and are untouched by this.
        // Switching tabs means "show me how it is now": a hidden tab stays mounted, so without
        // this the day would come back from cache as it was before the neighbour's work.
        refreshQueryKey={garageKeys.root}
        items={items}
      />
    </div>
  );
}
