import { Typography } from 'antd';
import { calcMechCost, type MechRequestDto } from '@technic/contracts';
import {
  mechDayLabel,
  mechDaysLeftLabel,
  mechMoney,
  mechModelLabel,
  mechRateLabel,
  mechRequesterLabel,
  mechTermLabel,
  mechWorkedLabel,
  MechStateTag,
} from '@entities/mech-request';
import type { ViewField } from '@shared/ui';
import { FileLinkList } from '../../components/FileLinks';
import { PhoneLink } from '../../components/PhoneField';
import { formatDateTime } from '../../utils/format';

/**
 * Поля карточки аренды — отдельным модулем от самого окна: их полтора десятка, у каждого своё
 * правило показа, и вместе с устройством окна они переросли бы ограничение длины файла. Окно
 * отвечает за вкладки, действия и запросы, состав полей — за ответ «что с арендой».
 *
 * Пустые поля не рисуются: у «Новой» нет ни арендодателя, ни ставки, ни факта — и прочерк в
 * половине карточки читался бы как потерянные данные, а не как «до этого ещё не дошло».
 */
export function mechRequestViewFields({
  request,
  today,
}: {
  request: MechRequestDto;
  /** Московский день: остаток срока считается тем же значением, что и в списке (Р12). */
  today: string;
}): ViewField[] {
  const left = mechDaysLeftLabel(request, today);
  const fields: ViewField[] = [
    { key: 'num', label: '№', children: request.displayNumber },
    { key: 'status', label: 'Состояние', children: <MechStateTag row={request} /> },
    { key: 'requester', label: 'Заявитель', children: mechRequesterLabel(request) },
    {
      key: 'object',
      label: 'Площадка',
      full: true,
      children: (
        <>
          {request.objectCode} — {request.objectName}
          {request.objectAddress.trim() && (
            <Typography.Text type="secondary" style={{ display: 'block', fontSize: 12 }}>
              {request.objectAddress}
            </Typography.Text>
          )}
        </>
      ),
    },
    { key: 'model', label: 'Модель', children: mechModelLabel(request) },
    {
      key: 'planned',
      label: 'Плановый срок',
      children: (
        <>
          {mechTermLabel(request)}
          {/* Остаток и просрочка — только у действующей аренды: у невыданной срок не начался, а у
              возвращённой кончился, и «осталось 3 дня» было бы неправдой в обоих случаях. */}
          {left && (
            <Typography.Text
              type={left.overdue ? 'danger' : 'secondary'}
              style={{ display: 'block', fontSize: 12 }}
            >
              {left.text}
            </Typography.Text>
          )}
        </>
      ),
    },
  ];

  // Договорённость показывается целиком либо не показывается вовсе: порознь эти поля не имеют
  // смысла, и база держит это одним инвариантом (Р6).
  if (request.lessorId) {
    fields.push(
      { key: 'lessor', label: 'Арендодатель', children: request.lessorName ?? '—' },
      { key: 'rate', label: 'Ставка', children: mechRateLabel(request.rate, request.rateUnit) },
    );
  }

  // Факт приходит по частям — выдача раньше возврата, — поэтому и поля отдельные.
  if (request.actualFrom) {
    fields.push({ key: 'actualFrom', label: 'Выдана', children: mechDayLabel(request.actualFrom) });
  }
  if (request.actualTo) {
    fields.push({
      key: 'actualTo',
      label: 'Возвращена',
      children: mechDayLabel(request.actualTo),
    });
  }
  if (request.actualUnits != null) {
    fields.push({
      key: 'actualUnits',
      label: 'Отработано',
      children: mechWorkedLabel(request.actualUnits, request.rateUnit),
    });
  }
  if (request.finalCost != null) {
    const calculated = calcMechCost(request.rate, request.actualUnits ?? 0);
    const mismatch =
      calculated !== null && Math.abs(request.finalCost - calculated) >= 0.01 ? calculated : null;
    fields.push({
      key: 'finalCost',
      label: 'Итоговая стоимость',
      children: (
        <>
          {mechMoney(request.finalCost)}
          {/* Расхождение с расчётом названо и здесь: разбирая счёт, спрашивают именно его — в
              сумме бывают подача, простой и округление, а сохранено введённое человеком. */}
          {mismatch !== null && (
            <Typography.Text type="secondary" style={{ display: 'block', fontSize: 12 }}>
              расчёт по ставке: {mechMoney(mismatch)}
            </Typography.Text>
          )}
        </>
      ),
    });
  }

  fields.push({
    key: 'responsible',
    label: 'Принимает технику',
    children: (
      <>
        {request.responsibleName || '—'}
        {request.responsiblePhone && (
          <div>
            <PhoneLink phone={request.responsiblePhone} />
          </div>
        )}
      </>
    ),
  });

  if (request.cancelReason) {
    fields.push({
      key: 'cancelReason',
      label: 'Причина отмены',
      full: true,
      children: request.cancelReason,
    });
  }
  if (request.comment) {
    fields.push({ key: 'comment', label: 'Комментарий', full: true, children: request.comment });
  }
  if (request.files.length > 0) {
    fields.push({
      key: 'files',
      label: 'Файлы',
      full: true,
      children: <FileLinkList files={request.files} />,
    });
  }

  fields.push({
    key: 'created',
    label: 'Заведена',
    children: `${formatDateTime(request.createdAt)} · ${request.createdByName}`,
  });
  if (request.deletedAt) {
    fields.push({
      key: 'deleted',
      label: 'В архиве с',
      children: `${formatDateTime(request.deletedAt)}${
        request.deletedByName ? ` · ${request.deletedByName}` : ''
      }`,
    });
  }

  return fields;
}
