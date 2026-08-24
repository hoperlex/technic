import { useState } from 'react';
import { Alert, App, Button, Collapse, Empty, Space, Table, Tag, Typography } from 'antd';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { WasteTicketCheckDto, WasteTicketDto } from '@technic/contracts';
import { wasteTicketKeys, wasteTicketsApi, wasteTicketsQuery } from '@entities/waste-ticket';
import { errorMessage } from '../../../utils/format';

/**
 * Разбор талонов в карточке заявки (ADR 0114, план §9.2).
 *
 * Панель показывается только тому, у кого есть право разбора: распознанные значения — такой же
 * результат сверки, как и замечания, и отдавать их проверяемому нельзя. Без права карточка
 * остаётся прежней — список файлов и просмотр, как было до распознавания.
 *
 * Главное правило экрана: **портал не решает за человека**. Спорное поле (модели прочитали
 * по-разному) остаётся пустым, показывает обоих кандидатов, а подтверждение блокируется — потому
 * что подтвердить значение, которого нет, значит согласиться с пустотой.
 */
export function WasteTicketsPanel({ requestId }: { requestId: string }) {
  const { message, modal } = App.useApp();
  const qc = useQueryClient();
  const { data, isLoading } = useQuery(wasteTicketsQuery(requestId, true));
  const [busyId, setBusyId] = useState<string | null>(null);

  const invalidate = () => qc.invalidateQueries({ queryKey: wasteTicketKeys.list(requestId) });

  const confirm = useMutation({
    mutationFn: (vars: { ticketId: string; reason?: string }) =>
      wasteTicketsApi.confirm(requestId, vars.ticketId, {
        duplicateOverrideReason: vars.reason,
      }),
    onSuccess: async (res) => {
      await invalidate();
      message.success(
        res.duplicateOverrideApplied
          ? 'Талон подтверждён, номер отмечен как другая бумага'
          : 'Талон подтверждён',
      );
    },
    onError: (e) => message.error(errorMessage(e)),
    onSettled: () => setBusyId(null),
  });

  const dismiss = useMutation({
    mutationFn: (ticketId: string) => wasteTicketsApi.dismiss(requestId, ticketId, {}),
    onSuccess: async () => {
      await invalidate();
      message.success('Талон снят');
    },
    onError: (e) => message.error(errorMessage(e)),
    onSettled: () => setBusyId(null),
  });

  const recognize = useMutation({
    mutationFn: (fileId: string) => wasteTicketsApi.recognize(requestId, fileId),
    onSuccess: async () => {
      await invalidate();
      message.success('Файл отправлен на повторное распознавание');
    },
    onError: (e) => message.error(errorMessage(e)),
  });

  if (isLoading) return <Typography.Text type="secondary">Загружаем талоны…</Typography.Text>;
  if (!data) return null;

  /**
   * Конфликт номера приходит ответом 409 и требует причины. Спрашиваем её тем же действием, а не
   * отдельной кнопкой: клапан ставится **только на конфликтующую строку**, и отдельная ручка «снять
   * ограничение» позволила бы снять его со старшей бумаги, открыв её номер всем следующим дублям.
   */
  const askOverride = (ticket: WasteTicketDto, reason: string) => {
    let text = '';
    modal.confirm({
      title: 'Это разные бумаги?',
      content: (
        <Space direction="vertical" style={{ width: '100%' }}>
          <Typography.Text>{reason}</Typography.Text>
          <Typography.Text type="secondary">
            Если номера совпали случайно (разные книжки перевозчика), опишите это — причина уйдёт в
            историю заявки.
          </Typography.Text>
          <textarea
            style={{ width: '100%', minHeight: 72 }}
            onChange={(e) => {
              text = e.target.value;
            }}
          />
        </Space>
      ),
      okText: 'Подтвердить с причиной',
      cancelText: 'Отмена',
      onOk: () => {
        if (text.trim().length < 3) {
          message.error('Опишите, почему бумаги разные');
          return Promise.reject(new Error('reason required'));
        }
        setBusyId(ticket.id);
        return confirm.mutateAsync({ ticketId: ticket.id, reason: text.trim() });
      },
    });
  };

  const onConfirm = (ticket: WasteTicketDto) => {
    setBusyId(ticket.id);
    confirm.mutate(
      { ticketId: ticket.id },
      {
        onError: (e) => {
          const text = errorMessage(e);
          // 409 про номер — не отказ, а вопрос: та же бумага или другая с тем же номером.
          if (text.includes('уже предъявлен')) askOverride(ticket, text);
          else message.error(text);
          setBusyId(null);
        },
      },
    );
  };

  return (
    <Space direction="vertical" size={12} style={{ width: '100%' }}>
      <ChecksStrip checks={data.checks} preliminary={data.preliminary} />

      {data.tickets.length === 0 ? (
        <Empty description="Талоны ещё не распознаны" image={Empty.PRESENTED_IMAGE_SIMPLE} />
      ) : (
        <Table<WasteTicketDto>
          size="small"
          rowKey="id"
          dataSource={data.tickets}
          pagination={false}
          columns={[
            {
              title: '№ талона',
              dataIndex: 'number',
              render: (value: string, row) =>
                row.needsReviewFields.includes('number') ? (
                  <Disputed field="номер" />
                ) : (
                  value || '—'
                ),
            },
            {
              title: 'Дата',
              dataIndex: 'issuedOn',
              render: (value: string | null, row) =>
                row.needsReviewFields.includes('issuedOn') ? (
                  <Disputed field="дата" />
                ) : (
                  (value ?? '—')
                ),
            },
            {
              title: 'Объём',
              dataIndex: 'volumeM3',
              render: (value: number | null, row) =>
                row.needsReviewFields.includes('volumeM3') ? (
                  <Disputed field="объём" />
                ) : value == null ? (
                  row.workKind === 'idle' ? (
                    <Typography.Text type="secondary">простой</Typography.Text>
                  ) : (
                    '—'
                  )
                ) : (
                  `${value} м³`
                ),
            },
            { title: 'Адрес', dataIndex: 'addressRaw', ellipsis: true },
            {
              title: 'Состояние',
              key: 'state',
              render: (_, row) => <TicketState ticket={row} />,
            },
            {
              title: '',
              key: 'actions',
              render: (_, row) =>
                row.status === 'confirmed' || row.status === 'dismissed' ? null : (
                  <Space size={4}>
                    <Button
                      size="small"
                      type="link"
                      loading={busyId === row.id}
                      disabled={row.needsReviewFields.length > 0}
                      title={
                        row.needsReviewFields.length > 0
                          ? 'Сначала разберите спорные поля'
                          : undefined
                      }
                      onClick={() => onConfirm(row)}
                    >
                      Подтвердить
                    </Button>
                    <Button
                      size="small"
                      type="link"
                      danger
                      onClick={() => {
                        setBusyId(row.id);
                        dismiss.mutate(row.id);
                      }}
                    >
                      Не талон
                    </Button>
                  </Space>
                ),
            },
          ]}
        />
      )}

      {data.files.length > 0 && (
        <Collapse
          size="small"
          ghost
          items={[
            {
              key: 'files',
              label: 'Файлы и попытки распознавания',
              children: (
                <Space direction="vertical" size={8} style={{ width: '100%' }}>
                  {data.files.map((file) => (
                    <Space key={file.fileId} size={8} wrap>
                      <FileState file={file} />
                      <Button
                        size="small"
                        type="link"
                        onClick={() => recognize.mutate(file.fileId)}
                      >
                        Перераспознать
                      </Button>
                    </Space>
                  ))}
                  {/* Идентификатор запроса в прокси — то, что называют оператору при разборе. */}
                  {data.attempts.map((a) => (
                    <Typography.Text key={a.id} type="secondary" style={{ fontSize: 12 }}>
                      {new Date(a.createdAt).toLocaleString('ru-RU')} · {a.model}
                      {a.modelReported && a.modelReported !== a.model
                        ? ` (отработала ${a.modelReported})`
                        : ''}{' '}
                      · {a.status === 'done' ? 'успех' : `отказ ${a.errorCode}`}
                      {a.proxyRequestId ? ` · ${a.proxyRequestId}` : ''}
                    </Typography.Text>
                  ))}
                </Space>
              ),
            },
          ]}
        />
      )}
    </Space>
  );
}

/** Спорное поле: значения нет, потому что модели прочитали разное (Р14). */
function Disputed({ field }: { field: string }) {
  return (
    <Tag color="gold" title={`Модели прочитали ${field} по-разному — разберите вручную`}>
      спорно
    </Tag>
  );
}

function TicketState({ ticket }: { ticket: WasteTicketDto }) {
  if (ticket.status === 'confirmed') {
    return (
      <Space size={4}>
        <Tag color="green">подтверждён</Tag>
        {ticket.origin === 'manual' && <Tag>вручную</Tag>}
        {ticket.duplicateOverride && <Tag color="orange">другая бумага</Tag>}
      </Space>
    );
  }
  if (ticket.status === 'dismissed') return <Tag>снят</Tag>;
  return <Tag color="blue">на проверке</Tag>;
}

/** Состояние файла словами человека, а не кодом (Р29). */
function FileState({ file }: { file: { status: string; reason: string; fileId: string } }) {
  if (file.status === 'done') return <Typography.Text>Файл разобран</Typography.Text>;
  if (file.status === 'pending') return <Typography.Text>Распознаётся…</Typography.Text>;
  return <Typography.Text type="danger">{file.reason || 'Файл не распознан'}</Typography.Text>;
}

/**
 * Полоса замечаний. Красным — то, что мешает деньгам, жёлтым — то, что мешает порядку. Снятое
 * замечание не исчезает, а становится серым: человек должен видеть, что расхождение было и кто его
 * принял, иначе следующий разбирающий начнёт с нуля.
 */
function ChecksStrip({
  checks,
  preliminary,
}: {
  checks: WasteTicketCheckDto[];
  preliminary: boolean;
}) {
  if (checks.length === 0) {
    return (
      <Alert
        type="success"
        showIcon
        message={preliminary ? 'Расхождений нет (предварительно)' : 'Расхождений нет'}
      />
    );
  }
  return (
    <Space direction="vertical" size={6} style={{ width: '100%' }}>
      {checks.map((check) => (
        <Alert
          key={`${check.code}:${check.subjectKey}`}
          // Снятое замечание становится серым, а не исчезает: следующий разбирающий должен видеть,
          // что расхождение было и кто его принял, иначе он начнёт разбираться с нуля.
          type={check.resolution ? 'info' : check.severity === 'error' ? 'error' : 'warning'}
          showIcon
          message={check.message}
          description={
            check.resolution
              ? `Принято: ${check.resolution.acceptedByName} · ${check.resolution.comment}`
              : check.preliminary
                ? 'Предварительно: не все талоны подтверждены'
                : undefined
          }
        />
      ))}
    </Space>
  );
}
