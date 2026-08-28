import { Badge, Tooltip } from 'antd';
import type { ServiceRequestDto } from '@technic/contracts';

/**
 * Метка непрочитанного в строке списка (§3.5). Две метки с разным смыслом, и разница между ними —
 * не оформление, а адресат:
 *
 * - **яркая, со счётом** — непрочитанные, адресованные МНЕ. Её видит каждый, кому видна заявка:
 *   коллега по отделу получает её на реплику «Заявителю», не будучи участником разговора;
 * - **блёклая точка, без счёта** — есть чужое новое. Показывается ТОЛЬКО участнику: серая точка на
 *   каждую чужую реплику была бы для наблюдателя шумом без действия.
 *
 * Число во второй метке не показывается намеренно: «сколько там чужого» — вопрос, на который
 * человеку нечего ответить, а честный `COUNT` стоил бы прохода там, где ответ «да» даёт первое же
 * совпадение (`unreadOthers` и приходит булевым).
 */
export function ServiceChatMark({
  request,
  onOpen,
}: {
  request: ServiceRequestDto;
  onOpen: (request: ServiceRequestDto) => void;
}) {
  const { unreadMine, unreadOthers, canWrite, participantSides } = request.chat;
  const participant = canWrite || participantSides.length > 0;
  const mine = unreadMine > 0;
  if (!mine && !(unreadOthers && participant)) return null;

  return (
    <Tooltip title={mine ? 'Вам написали в обсуждении' : 'В обсуждении есть новое'}>
      <span
        role="button"
        tabIndex={0}
        aria-label={mine ? `Обсуждение: новых ${unreadMine}` : 'Обсуждение: есть новое'}
        style={{ cursor: 'pointer', display: 'inline-flex' }}
        // Мишень — сама метка, а не ячейка: клик по строке открывает карточку, и всплыви он
        // отсюда — окно обсуждения открылось бы под карточкой (тот же приём, что у подписи «Вам: …»).
        onClick={(e) => {
          e.stopPropagation();
          onOpen(request);
        }}
        onKeyDown={(e) => {
          if (e.key !== 'Enter' && e.key !== ' ') return;
          e.stopPropagation();
          e.preventDefault();
          onOpen(request);
        }}
      >
        {mine ? (
          <Badge count={unreadMine} size="small" color="blue" />
        ) : (
          <Badge dot color="#d9d9d9" />
        )}
      </span>
    </Tooltip>
  );
}
