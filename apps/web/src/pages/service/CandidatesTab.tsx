import { useState, type ReactNode } from 'react';
import { Tag, Typography } from 'antd';
import type { TableColumnsType } from 'antd';
import { useQuery } from '@tanstack/react-query';
import {
  officeEquipmentCandidateStatusLabels,
  type OfficeEquipmentCandidateDto,
} from '@technic/contracts';
import {
  officeEquipmentCandidateKeys,
  officeEquipmentCandidatesApi,
  subjectCheckTitle,
} from '@entities/office-equipment-candidate';
import { statusAgeLabel } from '@entities/service-request';
import { CandidateReviewModal } from '@features/candidate-review';
import { DataTable, PageTableLayout } from '@shared/ui';
import { useListParams } from '@shared/lib';

/**
 * Очередь проверки сообщений о технике — подвкладка «На проверке» (план
 * `docs/office-equipment-candidate-plan.md`, §9).
 *
 * ОЧЕРЕДЬ ПО ВОЗРАСТУ, СТАРЫЕ СВЕРХУ, и это единственный список модуля с таким порядком. У
 * остальных вопрос «что нового», и свежее сверху на него отвечает; здесь вопрос «чья очередь», и
 * свежее сверху означало бы, что сообщение, до которого не дошли руки в первый день, не дождётся
 * проверки никогда — очередь работала бы как стек.
 *
 * СРОКА ПРОВЕРКИ НЕТ ВОВСЕ (В3): ни таблицы сроков, ни рассылки о залежавшихся кандидатах. Вместо
 * них — возраст в строке и счётчик в подписи подвкладки: у профиля «Ведение» очередь на глазах, а
 * «напоминание о просроченном» требует настройки N, своей строки рубильника и планировщика — трёх
 * новых мест ради того, чего никто не просил. Начнёт копиться — увидят по счётчику.
 *
 * ПОИСКА И ФИЛЬТРОВ ЗДЕСЬ НЕТ, и это не экономия. Очередь ожидающих — десяток строк, которые
 * разбирают целиком, а не ищут в них; поиск по номеру обещал бы ответ на вопрос «есть ли такой
 * аппарат», а его задают ПАРКУ — и отвечает на него рубеж дублей при заведении. Единственный
 * переключатель — «решённые»: он отвечает на «чем кончилось то, что я вчера разобрал».
 */
export function CandidatesTab({ toolbar }: { toolbar?: ReactNode }) {
  const [opened, setOpened] = useState<string | null>(null);
  const { params, onTableChange } = useListParams<{ status: string }>(
    // Рабочий срез присылается ЯВНО: отсутствие параметра сервер читает как «все состояния», а
    // очередь — это ожидающие. «Покажи ничего» отбором не бывает вовсе.
    { status: 'pending' },
    // Поиска у очереди нет вовсе, и пустой перечень ключей — это ответ, а не заглушка: искать в
    // десятке строк нечего, а вопрос «есть ли такой аппарат» задают парку.
    { searchKeys: [], filterKeys: ['status'] },
  );
  const query = { ...params, sortBy: 'createdAt', sortOrder: 'asc' as const };

  const { data, isFetching } = useQuery({
    queryKey: officeEquipmentCandidateKeys.list(query),
    queryFn: () => officeEquipmentCandidatesApi.list(query),
  });

  const columns: TableColumnsType<OfficeEquipmentCandidateDto> = [
    {
      title: 'Ждёт',
      dataIndex: 'createdAt',
      width: 110,
      render: (value: string) => statusAgeLabel(value),
    },
    {
      title: 'Аппарат',
      dataIndex: 'declaredModel',
      render: (_: string, row) => (
        <>
          <div>{subjectCheckTitle(row)}</div>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {row.equipmentType.name}
          </Typography.Text>
        </>
      ),
    },
    {
      title: 'Где стоит',
      dataIndex: 'location',
      render: (_: string, row) => `${row.object.code} — ${row.object.name} · ${row.location}`,
    },
    {
      title: 'Заявка',
      dataIndex: 'request',
      width: 120,
      // Заявка приходит `null`, когда она смотрящему не видна (Р9), — а не когда её нет: кандидатов
      // без заявки не бывает по построению. Прочерк здесь и означает «эта заявка не ваша».
      render: (_: unknown, row) => row.request?.displayNumber ?? '—',
    },
    {
      title: 'Состояние',
      dataIndex: 'status',
      width: 170,
      render: (_: string, row) => <Tag>{officeEquipmentCandidateStatusLabels[row.status]}</Tag>,
    },
  ];

  return (
    <>
      <PageTableLayout toolbar={toolbar}>
        <DataTable<OfficeEquipmentCandidateDto>
          columns={columns}
          card={{
            title: (row) => subjectCheckTitle(row),
            lines: [
              (row) => `${row.object.code} · ${row.location}`,
              (row) => `ждёт ${statusAgeLabel(row.createdAt)}`,
            ],
            onOpen: (row) => setOpened(row.id),
          }}
          data={data?.items ?? []}
          total={data?.total ?? 0}
          loading={isFetching}
          page={params.page}
          pageSize={params.pageSize}
          onChange={onTableChange}
          // Строка открывает окно проверки: разбирают сообщение целиком, а не по столбцам.
          onRowClick={(row) => setOpened(row.id)}
        />
      </PageTableLayout>

      <CandidateReviewModal candidateId={opened} onClose={() => setOpened(null)} />
    </>
  );
}
