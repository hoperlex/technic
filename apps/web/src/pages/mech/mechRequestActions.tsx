import { useState, type ReactNode } from 'react';
import { App } from 'antd';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  mechDeleteScope,
  mechTransitionResetsDeal,
  type MechRequestDto,
  type RequestStatus,
} from '@technic/contracts';
import { mechFailureText, mechRequestKeys, mechRequestsApi } from '@entities/mech-request';
import { MechTakeInWorkModal } from '@features/mech-take-in-work';
import { MechIssueModal, MechRevokeIssueModal } from '@features/mech-issue';
import { MechCompleteModal } from '@features/mech-complete';
import { MechExtendModal } from '@features/mech-extend';
import type { ActionSheetItem } from '@shared/ui';
import { CancelReasonModal, RollbackReasonModal } from '../../components/CancelReasonModal';
import { useAuth } from '../../auth/AuthContext';
import { mechMenuItems } from './mechRequestMenu';

/**
 * Чем действие аренды делается: окна, подтверждения и мутации без окна.
 *
 * Что субъекту доступно — вопрос другой, и он живёт соседним модулем (`mechRequestMenu`): состав
 * пунктов считают барьеры контрактов и есть чистая функция от заявки и субъекта. Хук её зовёт и
 * подставляет ей окна и три действия, у которых окна нет.
 *
 * Набор заводится **на каждое место вызова свой** (ADR 0140): окна строки списка живут на уровне
 * вкладки, окна карточки — внутри карточки. Один и тот же набор отрисовать в двух местах нельзя —
 * это два экземпляра одного окна, и второй прячется под первым.
 */
export function useMechRequestActions({
  onEdit,
}: {
  /**
   * Правка открывает форму, а форма принадлежит вкладке: набор действий ею не владеет. Не передана
   * — пункта «Редактировать» в меню нет: так вкладка «В аренде» и живёт, формы у неё нет.
   */
  onEdit?: (request: MechRequestDto) => void;
}): {
  actionsFor: (request: MechRequestDto) => ActionSheetItem[];
  modals: ReactNode;
  /** Погасить все окна набора: нужно тому, чьи окна живут внутри карточки (ADR 0140). */
  close: () => void;
  pending: boolean;
} {
  const { user } = useAuth();
  const { message, modal } = App.useApp();
  const qc = useQueryClient();

  const [dealTarget, setDealTarget] = useState<MechRequestDto | null>(null);
  const [dealMode, setDealMode] = useState<'start' | 'deal'>('start');
  const [issueTarget, setIssueTarget] = useState<MechRequestDto | null>(null);
  const [revokeTarget, setRevokeTarget] = useState<MechRequestDto | null>(null);
  const [extendTarget, setExtendTarget] = useState<MechRequestDto | null>(null);
  const [completeTarget, setCompleteTarget] = useState<MechRequestDto | null>(null);
  const [cancelTarget, setCancelTarget] = useState<MechRequestDto | null>(null);
  /**
   * Возврат в «Новую» держится отдельным состоянием от отмены: окно причины у них одно, а перечень
   * стираемого свой — по одному состоянию окно не отличило бы возврат от отмены.
   */
  const [rollbackTarget, setRollbackTarget] = useState<MechRequestDto | null>(null);

  const refresh = () => void qc.invalidateQueries({ queryKey: mechRequestKeys.root });
  const close = () => {
    setDealTarget(null);
    setIssueTarget(null);
    setRevokeTarget(null);
    setExtendTarget(null);
    setCompleteTarget(null);
    setCancelTarget(null);
    setRollbackTarget(null);
  };

  /**
   * Отмена и откаты — общей ручкой статуса: из содержания у них только причина, и заводить каждому
   * свою ручку значило бы описывать один и тот же запрос трижды.
   */
  const statusMutation = useMutation({
    mutationFn: (v: { request: MechRequestDto; status: RequestStatus; comment?: string }) =>
      mechRequestsApi.changeStatus(v.request.id, {
        status: v.status,
        comment: v.comment ?? '',
        version: v.request.version,
      }),
    onSuccess: () => {
      close();
      message.success('Статус заявки изменён');
      refresh();
    },
    onError: (e) => {
      message.error(mechFailureText(e));
      // Список перечитывается и после отказа: 409 означает, что строка под руками уже другая, и
      // оставить на экране прежнюю значило бы предложить повторить ту же ошибку.
      refresh();
    },
  });

  const duplicateMutation = useMutation({
    mutationFn: (request: MechRequestDto) => mechRequestsApi.duplicate(request.id),
    onSuccess: (created) => {
      message.success(`Заведена копия: ${created.displayNumber}`);
      refresh();
    },
    onError: (e) => message.error(mechFailureText(e)),
  });

  const removeMutation = useMutation({
    mutationFn: (request: MechRequestDto) => mechRequestsApi.remove(request.id, request.version),
    onSuccess: (res) => {
      // Что именно случилось, говорит сервер: барьер состояния считает то же самое до нажатия, но
      // между чтением строки и записью её мог поменять сосед.
      message.success(res.mode === 'hard' ? 'Заявка удалена' : 'Заявка перемещена в архив');
      refresh();
    },
    onError: (e) => message.error(mechFailureText(e)),
  });

  /**
   * Подтверждение удаления говорит, что именно случится: «Новая» стирается физически вместе с
   * вложениями (ADR 0070) — просьба, о которой передумали, историей не является, — а прочие уходят
   * в архив и возвращаются оттуда администратором.
   */
  const confirmRemove = (request: MechRequestDto) => {
    const hard = mechDeleteScope(request) === 'hard';
    modal.confirm({
      title: `Удалить заявку ${request.displayNumber}?`,
      content: hard
        ? 'Заявка будет удалена вместе с вложениями: восстановить её будет нечем.'
        : 'Заявка уйдёт в архив: восстановить её сможет администратор.',
      okText: 'Удалить',
      okButtonProps: { danger: true },
      cancelText: 'Отмена',
      onOk: () => removeMutation.mutateAsync(request),
    });
  };

  const actionsFor = (request: MechRequestDto): ActionSheetItem[] =>
    mechMenuItems(request, {
      user,
      open: {
        takeInWork: (r) => {
          setDealMode('start');
          setDealTarget(r);
        },
        editDeal: (r) => {
          setDealMode('deal');
          setDealTarget(r);
        },
        issue: setIssueTarget,
        revokeIssue: setRevokeTarget,
        extend: setExtendTarget,
        complete: setCompleteTarget,
        cancel: setCancelTarget,
        rollbackToNew: setRollbackTarget,
        edit: onEdit,
      },
      run: {
        rollback: (r, status) => statusMutation.mutate({ request: r, status }),
        duplicate: (r) => duplicateMutation.mutate(r),
        remove: confirmRemove,
      },
    });

  const modals = (
    <>
      <MechTakeInWorkModal
        request={dealTarget}
        mode={dealMode}
        onClose={() => setDealTarget(null)}
      />
      <MechIssueModal request={issueTarget} onClose={() => setIssueTarget(null)} />
      <MechRevokeIssueModal request={revokeTarget} onClose={() => setRevokeTarget(null)} />
      <MechExtendModal request={extendTarget} onClose={() => setExtendTarget(null)} />
      <MechCompleteModal request={completeTarget} onClose={() => setCompleteTarget(null)} />
      <CancelReasonModal
        open={!!cancelTarget}
        subject={cancelTarget?.displayNumber}
        confirmLoading={statusMutation.isPending}
        onCancel={() => setCancelTarget(null)}
        onSubmit={(comment) =>
          statusMutation.mutate({ request: cancelTarget!, status: 'cancelled', comment })
        }
      />
      <RollbackReasonModal
        open={!!rollbackTarget}
        subject={rollbackTarget?.displayNumber}
        confirmLoading={statusMutation.isPending}
        /*
         * Что именно потеряет ЭТА заявка — по её собственным данным. У механизации возврат в
         * «Новую» стирает договорённость (`mechTransitionResetsDeal`): арендодателя, ставку и
         * единицу. Факта здесь не бывает — выданную заявку в «Новую» не пускает барьер, и пункта в
         * меню у неё нет вовсе.
         */
        erases={
          rollbackTarget && mechTransitionResetsDeal(rollbackTarget.status, 'new')
            ? ['Арендодатель, ставка и единица ставки']
            : []
        }
        onCancel={() => setRollbackTarget(null)}
        onSubmit={(comment) =>
          statusMutation.mutate({ request: rollbackTarget!, status: 'new', comment })
        }
      />
    </>
  );

  return {
    actionsFor,
    modals,
    close,
    pending: statusMutation.isPending || duplicateMutation.isPending || removeMutation.isPending,
  };
}
