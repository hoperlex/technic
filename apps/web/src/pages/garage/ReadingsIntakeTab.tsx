import { DatePicker, Space } from 'antd';
import dayjs from 'dayjs';
import { useQuery } from '@tanstack/react-query';
import type { ReadingIntakeRow } from '@technic/contracts';
import { vehicleReadingKeys, vehicleReadingsApi } from '@entities/vehicle-reading';
import { DataTable, PageTableLayout, SummaryBar } from '@shared/ui';
import { useListParams } from '@shared/lib';
import { TabsExtra, useActiveTabKey } from '../../components/PageTabs';
import { useReadingsAddress } from './readingsAddress';
import { intakeColumns } from './intakeColumns';
import { IntakeAcceptButton } from './IntakeAcceptButton';
import { IntakeReportModal } from './IntakeReportModal';
import { useIntakeRowOpen } from './intakeOpenDay';

/**
 * Гараж → «Показания» → «Приём»: с кого сегодня ждут показания и что с ними не так
 * (план «Показания техники», §7, Р1, Р5—Р9а, Р23, Р26, Р29).
 *
 * Реестр строится от **ожидаемых смен**, а не от строк отчётов (Р26), и это делает сервер: день,
 * который водитель не открывал, строк ожидания не имеет вовсе — а показаний с него ждут, и ровно
 * ради таких дней экран и нужен. Портал такие строки не отличает от прочих: у виртуальной нет
 * `itemId` и показания, а почему её видно — сказано её же пометкой.
 *
 * Уровень строки и тексты пометок приходят с сервера (Р5, Р7): второй формулы уровня на портале
 * нет — см. [intakeColumns](./intakeColumns.tsx).
 *
 * **Кнопка приёма считает отчёты, а не строки** (Р9а): счётчик берётся из `reports` — списка всех
 * отчётов периода со счётчиками по всем их строкам, — потому что пагинация делит отчёт между
 * страницами. Поэтому же ответ реестра несёт отчёты рядом со страницей строк.
 *
 * Период живёт в адресе (Р29), а умолчание у него своё — неделя, кончающаяся днём среза
 * (`readingsAddress`): приём открывают утром вопросом «что не сдано», а не «сколько проехали за
 * месяц».
 */

const DATE = 'YYYY-MM-DD';
const SHOWN_DATE = 'DD.MM.YYYY';

export function ReadingsIntakeTab({ date }: { date: string }) {
  const active = useActiveTabKey() === 'readings';
  const { period, setPeriod, reportId, openReport } = useReadingsAddress(date);
  /** Вход в отчёт: у виртуальной строки его сначала надо завести за работника (Р26). */
  const openRow = useIntakeRowOpen(openReport);
  /*
   * Своих полей у параметров списка нет — период живёт в адресе (Р29), а сортировки и поиска у
   * реестра не бывает: порядок строк задал сервер. Остаются страница и её размер.
   */
  const { params, setParams, onTableChange } = useListParams<Record<never, never>>(
    {},
    { searchKeys: [] },
  );

  const query = { from: period[0], to: period[1], page: params.page, pageSize: params.pageSize };
  const { data, isFetching } = useQuery({
    queryKey: vehicleReadingKeys.intake(query),
    queryFn: () => vehicleReadingsApi.intake(query),
    /*
     * Только на своей вкладке. Скрытая вкладка не размонтируется (`PageTabs`), и без этого условия
     * реестр за неделю пересобирался бы на сервере всякий раз, когда смотрят срез дня; с ним же
     * возвращение на вкладку показывает свежие строки, а не снимок получасовой давности.
     */
    enabled: active,
  });

  const reports = data?.reports ?? [];

  /** Другой период — другие строки: третья страница прежнего отрезка означала бы уже не те смены. */
  const changePeriod = (from: string, to: string) => {
    setParams((prev) => ({ ...prev, page: 1 }));
    setPeriod(from, to);
  };

  const summaryItems = [
    { label: 'Строк', value: data?.total ?? 0 },
    { label: 'Отчётов', value: reports.length },
    /*
     * День, по которому посчитана просрочка, — серверный московский (Р23). Он стоит на экране не
     * для полноты: красная строка объясняется словами «нет показания 4 дня», и отсчитаны они от
     * этого дня, а не от часов браузера. Реестр, открытый в полночь или в другом поясе, иначе
     * расходился бы с собственными пометками.
     */
    { label: 'Просрочка на', value: data ? dayjs(data.today).format(SHOWN_DATE) : '—' },
  ];

  return (
    <PageTableLayout>
      <TabsExtra tabKey="readings">
        <Space size={12} wrap>
          <DatePicker.RangePicker
            format={SHOWN_DATE}
            allowClear={false}
            value={[dayjs(period[0]), dayjs(period[1])]}
            onChange={(v) => {
              if (v?.[0] && v[1]) changePeriod(v[0].format(DATE), v[1].format(DATE));
            }}
          />
          <IntakeAcceptButton reports={reports} />
          <SummaryBar title="Приём" items={summaryItems} />
        </Space>
      </TabsExtra>

      <DataTable<ReadingIntakeRow>
        rowKey="key"
        columns={intakeColumns}
        data={data?.items ?? []}
        total={data?.total ?? 0}
        loading={isFetching}
        page={params.page}
        pageSize={params.pageSize}
        /*
         * Строка ведёт в отчёт дня, а не в машину: разбирают день целиком — соседние смены того же
         * водителя объясняют друг друга. У виртуальной строки неоткрытого дня отчёта ещё нет, и
         * тогда первым шагом его заводят за работника (Р26) — это и делает `openRow`.
         */
        onRowClick={openRow}
        onChange={onTableChange}
      />

      {/*
       * Окно рисуется в портале поверх всей страницы — поэтому его показывает только своя вкладка:
       * без проверки `active` уход на «Технику» оставлял бы открытое окно висеть над чужим списком,
       * ведь скрытая вкладка не размонтируется.
       *
       * Отчёт карточка спрашивает сама, по идентификатору из адреса, а не берёт из ответа реестра:
       * ссылку открывают и без реестра под рукой, а разбирают день по составу и расхождениям —
       * реестр же знает про отчёт три числа (Р9а).
       */}
      {active && reportId && (
        <IntakeReportModal reportId={reportId} onClose={() => openReport(null)} />
      )}
    </PageTableLayout>
  );
}
