import { App } from 'antd';
import dayjs from 'dayjs';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { ReadingIntakeRow } from '@technic/contracts';
import { vehicleReadingKeys, vehicleReadingsApi } from '@entities/vehicle-reading';
import { errorMessage } from '@shared/lib';
import { useAuth } from '../../auth/AuthContext';

/**
 * Вход в отчёт из строки реестра — включая тот день, которого ещё нет (план «Показания техники»,
 * Р26, Р29).
 *
 * Реестр строится от **ожидаемых смен**, а не от строк отчётов: день, который никто не открывал,
 * строк ожидания не имеет вовсе — а показания с него ждут. У такой строки `reportId` пуст, и
 * открывать нечего: сначала отчёт надо завести, и заводит его персонал за работника (`open`).
 * Ровно ради этого случая экран и нужен — у части водителей учётки не будет ещё долго.
 *
 * Спрашивается это подтверждением, а не молча: открытие заводит в чужом дне строки ожидания по
 * источникам — учётный след, который потом видно в гараже. Нажатие на строку списка такого следа
 * не обещает.
 *
 * Хуком, а не компонентом: вход у строки один, но состояние (запрос, подтверждение, сообщение об
 * отказе) принадлежит экрану, а не строке таблицы, — и рисовать его в каждой из полусотни строк
 * значило бы завести полсотни одинаковых окон.
 */
export function useIntakeRowOpen(
  openReport: (id: string | null) => void,
): (row: ReadingIntakeRow) => void {
  const { can } = useAuth();
  const { message, modal } = App.useApp();
  const qc = useQueryClient();

  const open = useMutation({
    mutationFn: (row: { personId: string; reportDate: string }) =>
      vehicleReadingsApi.openDay(row.personId, row.reportDate),
    onSuccess: (report) => {
      /*
       * Реестр обязан перечитаться: открытый день перестал быть виртуальной строкой, и у неё
       * появился отчёт со своими счётчиками. Гасится корень слайса (Р19) — те же строки считает
       * и гараж, и сводка.
       */
      void qc.invalidateQueries({ queryKey: vehicleReadingKeys.root });
      // Адрес называет предмет: открытый отчёт — тот же переход, что и по обычной строке.
      openReport(report.id);
    },
    onError: (e) => message.error(errorMessage(e)),
  });

  return (row) => {
    if (row.reportId) {
      openReport(row.reportId);
      return;
    }
    if (!row.personId) {
      // Живой координаты у строки нет: источник переназначен или аннулирован, и работника,
      // за которого открывать день, реестр назвать не может. Это разбирают расхождением.
      message.info('У этой смены нет работника — отчёт открывать не за кого');
      return;
    }
    if (!can('vehicleReadings.write')) {
      // Читающему объясняют, почему строка не открывается: пустое нажатие читается как поломка.
      message.info('Отчёт за этот день ещё не открывали — открыть его может тот, кто ведёт приём');
      return;
    }

    const { personId, reportDate } = row;
    modal.confirm({
      title: `Открыть отчёт за ${row.personName || 'работника'}?`,
      content: `За ${dayjs(reportDate).format('DD.MM.YYYY')} отчёт ещё не открывали. Портал заведёт его строки по выездам этого дня — после этого показания можно внести за работника.`,
      okText: 'Открыть',
      cancelText: 'Отмена',
      onOk: () => open.mutateAsync({ personId, reportDate }),
    });
  };
}
