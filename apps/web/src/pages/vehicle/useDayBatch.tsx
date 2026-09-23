import { useState, type ReactNode } from 'react';
import { App } from 'antd';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type {
  DayBatchApplyBody,
  VehicleRequestDayBatchResultDto,
  VehicleRequestDaysDto,
} from '@technic/contracts';
import { vehicleRequestKeys, vehicleRequestsApi } from '@entities/vehicle-request';
import { vehicleRouteKeys } from '@entities/vehicle-route';
import { waybillKeys } from '@entities/waybill';
import { garageKeys } from '@entities/garage';
import { errorMessage } from '../../utils/format';
import type { DayBatchFormValues } from './DayBatchFields';
import { DayBatchReport } from './DayBatchReport';

/**
 * Разговор с дверью пачки «4-П на весь период» (ADR 0207): тело, гашение кэша и отчёт, который
 * приезжает вместе с ответом.
 *
 * Хуком, а не блоком каждого окна, потому что зовут пачку два места — галочка окна принятия в
 * работу и кнопка таблицы дней, — и одинаковым у них обязано быть всё: и то, как собрано тело, и
 * то, какие списки после полусотни бумаг считаются устаревшими. Забытый одним из окон ключ кэша —
 * это не падение, а тихо старая картина: гараж показывает свободную машину, журнал листов не
 * знает о выписанных бланках.
 *
 * Окна отличаются одним — ценой отказа, и она приходит пропом (`failureHint`). У кнопки таблицы
 * дней отказ безобиден: ничего не произошло, нажмут ещё раз. У галочки — нет: заявка к этому
 * моменту уже в работе, откатывать её нельзя, и человек обязан узнать, что бумага не выписалась, а
 * заявка взята.
 */

/**
 * Тело пачки. Собирается ровно в одном месте: второй сборщик разошёлся бы с первым на первом же
 * новом поле — и одно из двух окон начало бы отправлять не то, что показывает.
 */
export function dayBatchBody(v: DayBatchFormValues, operationId: string): DayBatchApplyBody {
  return {
    driverPersonId: v.dayBatchDriverId!,
    /*
     * Поля не спрашивали — значит листы нужны. Так устроено окно принятия в работу: там галочка
     * называется «выписать 4-П на весь период», и разделение «сначала рейсы, бумага потом» ей
     * противоречит. Спрашивает о нём только окно пачки, где добирают пропущенное.
     */
    issueWaybills: v.dayBatchIssue ?? true,
    // Пустая причина уходит отсутствием ключа, а не пустой строкой: «объяснения не давали» и
    // «объяснение пустое» — разные вещи, и схема двери принимает только первое.
    ...(v.dayBatchReason?.trim() ? { reason: v.dayBatchReason.trim() } : {}),
    /*
     * Ключ повтора — свой на каждое нажатие (ADR 0207 решение 11). Он не про «нажали дважды»: по
     * нему сервер узнаёт свой же оборванный запрос и не выписывает вторую стопку бланков на те же
     * дни. Остаток, добираемый повторным нажатием, — это другая операция, и ключ у неё другой.
     */
    operationId,
  };
}

interface Options {
  /**
   * Новая таблица дней: пачка отдаёт её целиком, а владеет кэшем таблицы тот, кто её показывает.
   * Зовётся только на успехе — это же и признак «пачка прошла»: окно пачки закрывается отсюда.
   */
  onDays?: (days: VehicleRequestDaysDto) => void;
  /**
   * Чем объяснить отказ там, где сделанное уже не отменить. Пусто — отказ говорит сам за себя.
   */
  failureHint?: string;
}

export function useDayBatch({ onDays, failureHint }: Options = {}): {
  apply: (v: { requestId: string; values: DayBatchFormValues }) => void;
  applying: boolean;
  /** Отчёт пачки: держится состоянием хука, а не окна, — окно к этому моменту уже закрыто. */
  report: ReactNode;
} {
  const { message } = App.useApp();
  const qc = useQueryClient();
  const [result, setResult] = useState<VehicleRequestDayBatchResultDto | null>(null);

  const mut = useMutation({
    mutationFn: (v: { requestId: string; values: DayBatchFormValues }) =>
      vehicleRequestsApi.planDayBatch(v.requestId, dayBatchBody(v.values, crypto.randomUUID())),
    onSuccess: (res: VehicleRequestDayBatchResultDto) => {
      setResult(res);
      onDays?.(res.days);
      // Заявки: в строке списка видны рейс и машина дня, а у самой заявки — другая версия.
      // Ключ корневой, поэтому под гашение попадает и таблица дней (`[…, id, 'days']`) — та, что
      // открыта не здесь, а в соседнем окне карточки.
      void qc.invalidateQueries({ queryKey: vehicleRequestKeys.root });
      // Рейсы: каждый день либо встал в чужой рейс, либо завёл новый — состав изменился у обоих.
      void qc.invalidateQueries({ queryKey: vehicleRouteKeys.root });
      // Журнал листов: пачка выписывает бланки строгой отчётности десятками, и журнал после неё
      // показывает не то, что в базе. Подённая дверь его не гасила — ей и нечего было: номера она
      // не расходует.
      void qc.invalidateQueries({ queryKey: waybillKeys.root });
      // Срез гаража: своих таблиц у него нет — день собирается сервером (ADR 0076), — а видно ли
      // в нём работу, решает состав рейса (ADR 0131). Без гашения диспетчер читает занятость,
      // которой уже нет, и свободную машину, которая весь месяц расписана.
      void qc.invalidateQueries({ queryKey: garageKeys.root });
    },
    onError: (e) => {
      // Дольше обычного и с объяснением: у окна принятия в работу этот отказ приходит поверх уже
      // совершённого перевода, и «Ошибка» в углу экрана читалась бы как «ничего не произошло».
      message.error(failureHint ? `${failureHint} ${errorMessage(e)}` : errorMessage(e), 10);
    },
  });

  return {
    apply: mut.mutate,
    applying: mut.isPending,
    report: <DayBatchReport result={result} onClose={() => setResult(null)} />,
  };
}
