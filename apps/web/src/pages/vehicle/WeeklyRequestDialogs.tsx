import {
  type AnnulWeeklyRequestBody,
  type WeeklyCorrectionBody,
  type WeeklyVehicleRequestDto,
} from '@technic/contracts';
import { ReasonModal } from '@shared/ui';
import { weeklyReasonText } from './weeklyRequestPageState';
import { WeeklyRequestAnnulModal } from './WeeklyRequestAnnulModal';
import { WeeklyRequestConductModal } from './WeeklyRequestConductModal';

/**
 * Три окна страницы недельной заявки — одной группой.
 *
 * Своим файлом не ради красоты: у страницы шесть сценариев (сборка, подача, виза, проведение
 * задним числом, снятие, аннулирование), и бюджет длины её файла — единственный сторож против
 * того, чтобы седьмой дописали туда же. Окна не держат состояния вовсе: что открыто и чем
 * отвечать, решает страница, а здесь только разметка.
 *
 * Вместе они стоят потому, что отвечают на один вопрос — «чем страница спрашивает человека
 * прежде, чем сделать необратимое»: проведение жжёт номера бланков, аннулирование их гасит,
 * снятие и отказ требуют причины.
 */
export function WeeklyRequestDialogs(props: {
  /**
   * Обвязка аннулирования целиком (`useWeeklyAnnul`), а не её поля по одному: окно закрывает и
   * открывает она сама, и разложить её на пропсы значило бы дать странице решать то, что решает
   * хук.
   */
  annul: {
    target: WeeklyVehicleRequestDto | null;
    onClose: () => void;
    onAnnul: (body: AnnulWeeklyRequestBody) => void;
    pending: boolean;
  };
  /** Заявка для окна проведения; `null` — окно закрыто. */
  conducting: WeeklyVehicleRequestDto | null;
  reasonMode: 'cancel' | 'reject' | null;
  conductPending: boolean;
  reasonPending: boolean;
  onConductClose: () => void;
  onConduct: (correction: WeeklyCorrectionBody) => void;
  onReasonClose: () => void;
  onReasonSubmit: (reason: string) => void;
}) {
  return (
    <>
      {/* Проведение задним числом: цену операции спрашивают у сервера тем же кодом, которым он её
          исполнит, а причину и листы к перевыписке — у человека (ADR 0101). Мутация осталась на
          странице: проведение — это та же виза, и разбор её отказов должен быть один. */}
      <WeeklyRequestConductModal
        request={props.conducting}
        onClose={props.onConductClose}
        onConduct={props.onConduct}
        pending={props.conductPending}
      />

      {/* Аннулирование: цену разворота считает сервер тем же кодом, которым он её исполнит
          (ADR 0218), а причину и листы к перевыписке называет человек. */}
      <WeeklyRequestAnnulModal
        request={props.annul.target}
        onClose={props.annul.onClose}
        onAnnul={props.annul.onAnnul}
        pending={props.annul.pending}
      />

      <ReasonModal
        open={props.reasonMode !== null}
        {...weeklyReasonText(props.reasonMode === 'reject')}
        danger
        confirmLoading={props.reasonPending}
        onCancel={props.onReasonClose}
        onSubmit={props.onReasonSubmit}
      />
    </>
  );
}
