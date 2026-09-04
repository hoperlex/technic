import { useState } from 'react';
import { App, Button, Input, Select, Space, Typography } from 'antd';
import { useMutation } from '@tanstack/react-query';
import {
  chatMailNotice,
  chatMailTargets,
  isServiceRequestClosed,
  serviceRequestStatusLabels,
  type ServiceChatMessageDto,
  type ServiceRequestDto,
} from '@technic/contracts';
import { serviceRequestsApi } from '@entities/service-request';
import { useServiceChatInvalidate } from '../model/invalidate';
import {
  addresseeOptions,
  DEFAULT_ADDRESSEES,
  normalizeAddressees,
  splitAddressees,
  type AddresseeValue,
} from '../model/addressees';
import { errorMessage } from '../../../utils/format';

/** Подписи полей связаны с ними по `id`: своей формы у окна нет, а метка нужна и мыши, и экрану. */
const ADDRESSEE_FIELD = 'service-chat-addressees';
const BODY_FIELD = 'service-chat-body';

/**
 * Почему поля ввода нет. Два разных ответа, и разница между ними существенна для человека:
 * закрытая заявка молчит для всех, а наблюдателю не дано писать ни в одном статусе (решение 3 ADR).
 * Общее «писать нельзя» заставляло бы гадать, ждать ли открытия заявки.
 */
function WhyReadOnly({ request }: { request: ServiceRequestDto }) {
  const closed = isServiceRequestClosed(request.status);
  return (
    <Typography.Text type="secondary">
      {closed
        ? `Заявка в статусе «${serviceRequestStatusLabels[request.status]}»: обсуждение только читается.`
        : 'Писать в обсуждении могут стороны заявки и её автор — остальным оно открыто на чтение.'}
    </Typography.Text>
  );
}

/**
 * Поле ответа: кому и что.
 *
 * Умолчание адресата — «Всем участникам»: реплика без адресата не бывает вовсе (на пометке держатся
 * и подсветка, и состав получателей будущего письма), а требовать выбор у каждого «ждём запчасть»
 * значило бы просить решение там, где его нет.
 *
 * Выбор «Всем участникам» гасит остальные пункты — зеркало серверной проверки (§3.3): «всем» и
 * «ещё вот этому» противоречат друг другу, и запрет, объяснённый ответом 400 после нажатия,
 * читался бы как поломка портала.
 */
export function ServiceChatComposer({
  request,
  onSent,
}: {
  request: ServiceRequestDto;
  onSent: (message: ServiceChatMessageDto, lastSeq: number) => void;
}) {
  const { message: toast } = App.useApp();
  const invalidate = useServiceChatInvalidate();
  const [addressees, setAddressees] = useState<AddresseeValue[]>(DEFAULT_ADDRESSEES);
  const [body, setBody] = useState('');

  const mutation = useMutation({
    mutationFn: () =>
      serviceRequestsApi.sendChatMessage(request.id, {
        body: body.trim(),
        addressees: splitAddressees(addressees),
      }),
    onSuccess: (result) => {
      // Реплика показывается сразу: ответ несёт её целиком, и ждать следующего опроса, чтобы
      // увидеть собственное сообщение, — худшее, что окно переписки может сделать.
      onSent(result.message, result.lastSeq);
      setBody('');
      invalidate(request.id);
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  // Наблюдатель и закрытая заявка (§3.1): и то и другое сервер проверяет сам, а `canWrite` — его
  // же ответ. Второй копии правила здесь нет намеренно — она разошлась бы с ручкой молча.
  if (!request.chat.canWrite) return <WhyReadOnly request={request} />;

  return (
    <Space orientation="vertical" size={8} style={{ width: '100%' }}>
      <div>
        <label htmlFor={ADDRESSEE_FIELD}>Кому</label>
        <Select<AddresseeValue[]>
          id={ADDRESSEE_FIELD}
          mode="multiple"
          style={{ width: '100%' }}
          value={addressees}
          options={addresseeOptions(request.executors, addressees)}
          onChange={(next) => setAddressees(normalizeAddressees(next, addressees))}
          placeholder="Всем участникам"
        />
        {/*
          Кого затронет почта — до нажатия «Отправить» (план расширения почты, § 4). Реплика уходит
          письмом ТОЛЬКО адресатам, и у подрядчика без учётки письмо — единственный носитель: не
          скажи мы этого здесь, «написал же в заявке» осталось бы непрочитанным.

          Правило считает контрактная функция, а не своя формула рядом: вторая копия разошлась бы с
          серверной молча — ровно та беда, ради которой правила сторон живут в контрактах. А вот
          «идут ли письма вообще» портал не выводит сам: рубильник события, включённость почты и
          настроенность канала — это сервер, и он отвечает на них полем `chat.mailEnabled`.
        */}
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          {request.chat.mailEnabled
            ? chatMailNotice(chatMailTargets(splitAddressees(addressees)))
            : 'Письма по обсуждению сейчас не отправляются — сообщение увидят только в портале.'}
        </Typography.Text>
      </div>
      <div>
        <label htmlFor={BODY_FIELD}>Сообщение</label>
        <Input.TextArea
          id={BODY_FIELD}
          rows={3}
          // Тот же предел, что и у схемы: длиннее — это уже документ, и его подшивают вложением.
          maxLength={2000}
          showCount
          value={body}
          onChange={(e) => setBody(e.target.value)}
          placeholder="Например: ждём запчасть от поставщика, обещают к 3-му"
        />
      </div>
      <Button
        type="primary"
        loading={mutation.isPending}
        // Пустая реплика и реплика без адресата — отказ схемы; кнопка выражает его до нажатия.
        disabled={!body.trim() || addressees.length === 0}
        onClick={() => mutation.mutate()}
      >
        Отправить
      </Button>
    </Space>
  );
}
