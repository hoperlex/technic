import { App } from 'antd';
import { useMutation, useQueryClient, type QueryClient } from '@tanstack/react-query';
import type { OfficeEquipmentCandidateDto } from '@technic/contracts';
import { officeEquipmentCandidateKeys } from '@entities/office-equipment-candidate';
import {
  officeEquipmentConsumableKeys,
  officeEquipmentKeys,
  officeEquipmentModelKeys,
} from '@entities/office-equipment';
import { serviceRequestKeys } from '@entities/service-request';
import { isApiError } from '@shared/api';
import type { FormBlockersApi } from '@shared/ui';
import { errorMessage } from '@shared/lib';

/**
 * Что устаревает от решения по кандидату (план `docs/office-equipment-candidate-plan.md`, §9).
 *
 * ТОТ ЖЕ НАБОР, ЧТО У БЫСТРОГО СОЗДАНИЯ КАРТОЧКИ СЕГОДНЯ, и это не совпадение: «Завести карточку»
 * рождает единицу парка ровно так же, как окно быстрого создания из формы заявки, — значит меняет
 * и счётчик «В парке» у модели, и счётчик у привязанных к ней расходников (Н6). Объединение и
 * отказ гасят тот же набор намеренно: список кандидатов у них общий с подтверждением, а лишнее
 * гашение стоит одного перезапроса, тогда как забытое — показанного вчерашнего числа.
 *
 * ЗАЯВКА ГАСИТСЯ ТОЖЕ, и это половина смысла всей операции: решение проставляет заявке предмет,
 * переписывает её снимки и снимает замок приёмки (Р16). Не погаси её здесь — оператор с открытой
 * карточкой продолжал бы видеть «на проверке» и запертую кнопку «Принять работу» у заявки, по
 * которой решение уже принято.
 *
 * Одной функцией на все четыре двери (правка и три решения), а не пятью строками в каждой: забытая
 * строка в одной из них проявилась бы не отказом, а тем, что «иногда не обновляется».
 */
export function invalidateAfterCandidateDecision(qc: QueryClient): void {
  void qc.invalidateQueries({ queryKey: officeEquipmentCandidateKeys.root });
  void qc.invalidateQueries({ queryKey: officeEquipmentKeys.root });
  void qc.invalidateQueries({ queryKey: officeEquipmentModelKeys.root });
  void qc.invalidateQueries({ queryKey: officeEquipmentConsumableKeys.root });
  void qc.invalidateQueries({ queryKey: serviceRequestKeys.root });
}

/**
 * Слова, которыми портал объясняет 409 (Р11, Р12): их читают и правка, и все три решения.
 *
 * Формулировка называет ОБА исхода сразу — «решение уже приняли» и «форма устарела», — потому что
 * различить их портал не может и не должен: сервер отвечает одним отказом на условную запись
 * `WHERE status='pending' AND content_version=?`, а человеку в обоих случаях нужно одно и то же —
 * посмотреть свежее состояние прежде, чем нажимать снова.
 */
const CONFLICT_NOTICE =
  'Решение уже приняли или форма устарела — показываем свежее состояние сообщения';

/**
 * Одна дверь решения: мутация, свежий DTO в кэш, инвалидация и разбор 409.
 *
 * ОБЩИМ ХУКОМ НА ЧЕТЫРЕ ДЕЙСТВИЯ, потому что различаются они только телом запроса. Всё остальное у
 * них одинаково по построению: сервер возвращает свежего кандидата и у успеха, и у отказа версии,
 * а портал обязан в обоих случаях показать именно его, а не то, что лежало в форме. Четыре копии
 * этой обвязки разошлись бы на первой же правке — и разошлись бы молча, потерянной инвалидацией.
 *
 * СВЕЖИЙ DTO КЛАДЁТСЯ В КЭШ СРАЗУ (`setQueryData`), а не ждёт перезапроса: окно после решения
 * показывает исход и его причину, и секунда со старым состоянием читалась бы как «кнопка не
 * сработала». Перезапрос идёт следом — он же приносит решение всем прочим спискам.
 */
export function useCandidateDecision<TVars>(
  id: string,
  run: (vars: TVars) => Promise<OfficeEquipmentCandidateDto>,
  {
    success,
    onDone,
    blockers,
  }: {
    success: string;
    onDone?: () => void;
    /**
     * Форма, в которую ложатся отказы по полям: «Серийный номер уже заведён карточкой …» обязан
     * встать на самом поле, иначе проверяющий заведёт дубль, не поняв, какой из номеров занят.
     * Необязательна — у отказа и объединения полей карточки нет вовсе.
     */
    blockers?: FormBlockersApi;
  },
) {
  const { message } = App.useApp();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: run,
    onSuccess: (fresh) => {
      message.success(success);
      qc.setQueryData(officeEquipmentCandidateKeys.detail(id), fresh);
      invalidateAfterCandidateDecision(qc);
      onDone?.();
    },
    onError: (error) => {
      /*
       * 409 — ОБЫЧНЫЙ ОТВЕТ, А НЕ СБОЙ: двое проверяющих открыли одну строку очереди, и один из
       * них уже решил. Поэтому предупреждение, а не ошибка, и обязательный перезапрос карточки:
       * окно, оставшееся с прежней версией, отправило бы её ещё раз и получило бы тот же отказ.
       */
      if (isApiError(error) && error.status === 409) {
        message.warning(CONFLICT_NOTICE);
        void qc.invalidateQueries({ queryKey: officeEquipmentCandidateKeys.detail(id) });
        return;
      }
      if (!blockers?.fromApi(error)) message.error(errorMessage(error));
    },
  });
}
