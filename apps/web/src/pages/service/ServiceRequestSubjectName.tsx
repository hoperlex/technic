import { Alert } from 'antd';
import type { ServiceRequestDto } from '@technic/contracts';
import {
  serviceRequestSubjectCheck,
  subjectCheckNotice,
  subjectCheckTitle,
} from '@entities/office-equipment-candidate';
import { serviceRequestEquipmentName } from '@entities/service-request';

/**
 * Чем называется предмет заявки в её карточке — и что с ним сейчас происходит (план
 * `docs/office-equipment-candidate-plan.md`, Р5, Р15, §9).
 *
 * ТРИ ОТВЕТА НА ОДИН ВОПРОС, и различает их не оформление, а то, существует ли карточка парка.
 *
 *   * единица справочника — обычная подпись снимка заявки;
 *   * «Без аппарата» словами (Р8) — законное состояние заявки, а не пробел;
 *   * СООБЩЕНИЕ О ТЕХНИКЕ, ещё не ставшее карточкой: предмет называет само сообщение. «Без
 *     аппарата» здесь было бы неправдой — аппарат есть, его лишь не успели завести, — а ссылка на
 *     справочник вела бы в никуда: ссылаться пока не на что.
 *
 * ПЛАШКА ВИДНА И ЗАЯВИТЕЛЮ (§9), и это не послабление видимости: реквизиты кандидата и причина
 * решения не финансовые, поэтому проекция аудитории оставляет их обеим сторонам. Без строки
 * состояния автор не узнал бы ни того, что проверка идёт, ни того, почему её закончили отказом, —
 * и пошёл бы за ответом в ИТ-службу, то есть ровно тем звонком, ради отмены которого модуль и
 * заводился. Причина отказа поэтому печатается ДОСЛОВНО (Р15, В5).
 *
 * Отдельным компонентом от набора полей карточки: там живёт ответ «какие поля показать», здесь —
 * «как называется предмет», и вместе они перерастают порог длины файла.
 */
export function ServiceRequestSubjectName({ request }: { request: ServiceRequestDto }) {
  const check = serviceRequestSubjectCheck(request);
  return (
    <>
      <span>
        {check && !request.equipment
          ? subjectCheckTitle(check)
          : serviceRequestEquipmentName(request)}
      </span>
      {/* Отказ красным, а ожидание — обычным сообщением: «на проверке» это ход дела, а не беда, и
          красная плашка на нём читалась бы как поломка заявки. */}
      {check && (
        <Alert
          type={check.status === 'rejected' ? 'error' : 'info'}
          showIcon
          title={subjectCheckNotice(check)}
        />
      )}
    </>
  );
}
