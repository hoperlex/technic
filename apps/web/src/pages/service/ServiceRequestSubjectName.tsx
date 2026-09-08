import { Alert } from 'antd';
import { canCoordinateServiceRequests, type ServiceRequestDto } from '@technic/contracts';
import {
  serviceRequestSubjectCheck,
  subjectCheckNotice,
  subjectCheckTitle,
} from '@entities/office-equipment-candidate';
import { ServiceHint, serviceRequestEquipmentName } from '@entities/service-request';
import { useAuth } from '../../auth/AuthContext';

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
 * ДАННЫЕ ВИДНЫ И ЗАЯВИТЕЛЮ (§9), и это не послабление видимости: реквизиты кандидата и причина
 * решения не финансовые, поэтому проекция аудитории оставляет их обеим сторонам. Без строки
 * состояния автор не узнал бы, почему проверку закончили отказом, — и пошёл бы за ответом в
 * ИТ-службу, то есть ровно тем звонком, ради отмены которого модуль и заводился. Причина отказа
 * поэтому печатается ДОСЛОВНО (Р15, В5) и полной плашкой всем.
 *
 * А вот «на проверке» с выпуска «тише подсказки» остаётся одному «Ведению» (план
 * `docs/office-equipment-card-and-list-cleanup-plan.md`, Р11): ход дела — пояснение, а не ответ
 * на вопрос автора, и заказчик просил такие пояснения убрать (просьба 08.09.2026, п. 3).
 *
 * Отдельным компонентом от набора полей карточки: там живёт ответ «какие поля показать», здесь —
 * «как называется предмет», и вместе они перерастают порог длины файла.
 */
export function ServiceRequestSubjectName({ request }: { request: ServiceRequestDto }) {
  const { user } = useAuth();
  const check = serviceRequestSubjectCheck(request);
  return (
    <>
      <span>
        {check && !request.equipment
          ? subjectCheckTitle(check)
          : serviceRequestEquipmentName(request)}
      </span>
      {/* Отказ красным, а ожидание — обычным сообщением: «на проверке» это ход дела, а не беда, и
          красная плашка на нём читалась бы как поломка заявки.

          Отсюда и разная судьба двух половин при Р11: ОТКАЗ — полноценная плашка ВСЕГДА, включая
          заявителя. Он и написан для автора: дословная причина отказа и есть ответ на вопрос,
          ради которого человек иначе пошёл бы звонить в ИТ-службу, — свернув её в серую строку,
          мы отняли бы у него единственное объяснение. «На проверке» же — пояснение о ходе дела, и
          вне «Ведения» оно уходит по общему правилу. */}
      {check &&
        (check.status === 'rejected' ? (
          <Alert type="error" showIcon title={subjectCheckNotice(check)} />
        ) : (
          <ServiceHint
            coordinator={canCoordinateServiceRequests(user)}
            level="info"
            title={subjectCheckNotice(check)}
          />
        ))}
    </>
  );
}
