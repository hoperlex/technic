import { Tag } from 'antd';
import { serviceWaitingOnLabels, type ServiceWaitingOn } from '@technic/contracts';

/**
 * Цвет стороны: ИТ — фиолетовый (тот же, что у статуса «Согласована ИТ»), оператор — золотой
 * (решение о деньгах), сервис — синий (работа на его стороне).
 */
const colors: Record<ServiceWaitingOn, string | undefined> = {
  it: 'purple',
  operator: 'gold',
  service: 'blue',
  nobody: undefined,
};

/**
 * От кого сейчас ждут шага (Р35). Тег отвечает на главный вопрос к списку из трёх сторон: моя
 * очередь или чужая.
 *
 * «Ждёт меня» приходит признаком снаружи, а не считается здесь: сторону определяют права
 * (`isWaitingOn` в контрактах), а слою сущностей учётка не видна — он не знает ни `useAuth`, ни
 * правил портала. Зато он знает, как это показать, и показывает одинаково в списке и в карточке.
 */
export function WaitingOnTag({
  waiting,
  mine,
}: {
  waiting: ServiceWaitingOn;
  /** Ждут именно смотрящего: тег становится заметным — это его очередь, а не чужая. */
  mine?: boolean;
}) {
  if (mine) {
    return (
      <Tag color="volcano" style={{ marginInlineEnd: 0 }}>
        Ждёт вас
      </Tag>
    );
  }
  return (
    <Tag color={colors[waiting]} style={{ marginInlineEnd: 0 }}>
      {serviceWaitingOnLabels[waiting]}
    </Tag>
  );
}
