import { useState } from 'react';
import { Alert, App, Button, Collapse, Empty, Space, Typography } from 'antd';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { WasteTicketDto } from '@technic/contracts';
import { wasteTicketKeys, wasteTicketsApi, wasteTicketsQuery } from '@entities/waste-ticket';
import { FilePreviewModal } from '../../../components/FileLinks';
import { errorMessage } from '../../../utils/format';
import { BlindCheckPanel } from './BlindCheckPanel';
import { TicketFormModal } from './TicketFormModal';
import { TicketCard } from './TicketCard';
import { ChecksStrip, FileState } from './RecognitionState';

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
  /** Окно талона: `null` — закрыто, `{ticket: null}` — заведение руками, иначе правка. */
  const [form, setForm] = useState<{ ticket: WasteTicketDto | null } | null>(null);
  /** Скан, открытый рядом с полями: сверять цифру с бумагой удобнее не уходя из карточки. */
  const [scan, setScan] = useState<{
    fileId: string;
    filename: string;
    contentType?: string;
  } | null>(null);

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

  const acceptProposal = useMutation({
    mutationFn: (vars: { ticketId: string; reason?: string }) =>
      wasteTicketsApi.acceptProposal(requestId, vars.ticketId, {
        duplicateOverrideReason: vars.reason,
      }),
    onSuccess: async () => {
      await invalidate();
      message.success('Новое чтение принято');
    },
    onError: (e) => message.error(errorMessage(e)),
    onSettled: () => setBusyId(null),
  });

  const dismissProposal = useMutation({
    mutationFn: (ticketId: string) => wasteTicketsApi.dismissProposal(requestId, ticketId),
    onSuccess: async () => {
      await invalidate();
      message.success('Предложение отклонено');
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
        <Space orientation="vertical" style={{ width: '100%' }}>
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
    <Space orientation="vertical" size={12} style={{ width: '100%' }}>
      <ChecksStrip
        checks={data.checks}
        preliminary={data.preliminary}
        hasTickets={data.tickets.some((t) => t.status !== 'dismissed')}
      />

      {/* Ручной ввод — равноправный путь, а не запасной: машина читает не всё, а два талона на
          кадре видит как один (Р15). Кнопка на виду всегда, в том числе когда талонов нет вовсе. */}
      <Space size={8}>
        <Button size="small" onClick={() => setForm({ ticket: null })}>
          Добавить талон вручную
        </Button>
      </Space>

      {/* Приложенные сканы с тем, что в них нашлось. Имя файла само по себе не отвечает на вопрос
          «эта бумага разобрана?» — а рядом с номерами отвечает: видно и сколько талонов на кадре,
          и что файл вовсе не читали. */}
      {data.files.length > 0 && (
        <Space orientation="vertical" size={4} style={{ width: '100%' }}>
          {data.files.map((file) => {
            const pageIds = data.pages.filter((pg) => pg.fileId === file.fileId).map((pg) => pg.id);
            const found = data.tickets.filter(
              (ticket) => ticket.pageId && pageIds.includes(ticket.pageId),
            );
            return (
              <Space key={file.fileId} size={8} wrap>
                <Button
                  size="small"
                  type="link"
                  style={{ padding: 0 }}
                  onClick={() =>
                    setScan({
                      fileId: file.fileId,
                      filename: file.filename,
                      contentType: file.contentType,
                    })
                  }
                >
                  {file.filename || 'скан'}
                </Button>
                {found.length > 0 ? (
                  <Typography.Text style={{ fontSize: 13 }}>
                    {found.map((ticket) => ticket.number || '№ не прочитан').join(', ')}
                  </Typography.Text>
                ) : (
                  <Typography.Text type="secondary" style={{ fontSize: 13 }}>
                    {file.status === 'pending' ? 'распознаётся…' : 'талоны не найдены'}
                  </Typography.Text>
                )}
              </Space>
            );
          })}
        </Space>
      )}

      {data.tickets.length === 0 ? (
        <Empty description="Талоны ещё не распознаны" image={Empty.PRESENTED_IMAGE_SIMPLE} />
      ) : (
        // Карточкой на талон, а не строкой таблицы: человек сверяет с бумагой поле за полем, и
        // читать четыре значения по вертикали быстрее, чем выцеплять их из строки среди служебных
        // колонок. Один кадр с двумя талонами даёт две карточки — разбивка видна сразу.
        <Space orientation="vertical" size={8} style={{ width: '100%' }}>
          {data.tickets.map((row) => (
            <TicketCard
              key={row.id}
              ticket={row}
              page={data.pages.find((pg) => pg.id === row.pageId) ?? null}
              busy={busyId === row.id}
              onOpenScan={(fileId, filename) =>
                setScan({
                  fileId,
                  filename,
                  contentType: data.files.find((f) => f.fileId === fileId)?.contentType,
                })
              }
              onConfirm={() => onConfirm(row)}
              onEdit={() => setForm({ ticket: row })}
              onDismiss={() => {
                setBusyId(row.id);
                dismiss.mutate(row.id);
              }}
              onAcceptProposal={() => {
                setBusyId(row.id);
                acceptProposal.mutate({ ticketId: row.id });
              }}
              onDismissProposal={() => {
                setBusyId(row.id);
                dismissProposal.mutate(row.id);
              }}
            />
          ))}
        </Space>
      )}

      {/* «На кадре два талона — проверьте, что распознаны оба» (Р10). Строка появляется только
          когда машина насчитала больше одного: у обычной страницы сообщать нечего. */}
      {data.pages.some((page) => page.ticketsFound > 1) && (
        <Alert
          type="info"
          showIcon
          title="На некоторых кадрах больше одного талона"
          description={data.pages
            .filter((page) => page.ticketsFound > 1)
            .map((page) => `страница ${page.pageNo}: ${page.ticketsFound}`)
            .join('; ')}
        />
      )}

      {data.files.length > 0 && (
        <Collapse
          size="small"
          ghost
          // Развёрнут сразу, если есть что показать по существу: свёрнутый блок с ответом на
          // вопрос «почему талонов нет» ничем не лучше отсутствующего.
          defaultActiveKey={
            data.files.some((f) => f.status !== 'done') ? ['files'] : undefined
          }
          items={[
            {
              key: 'files',
              label: 'Файлы и попытки распознавания',
              children: (
                <Space orientation="vertical" size={8} style={{ width: '100%' }}>
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
                      {a.status !== 'done' && a.errorClass
                        ? ` (${a.errorClass === 'transient' ? 'повторится' : 'терминальный'}${
                            a.errorScope === 'subsystem' ? ', сбой сервиса' : ''
                          })`
                        : ''}
                      {a.error ? ` — ${a.error}` : ''}
                      {/* Идентификатор запроса в прокси называют оператору при разборе. */}
                      {a.proxyRequestId ? ` · ${a.proxyRequestId}` : ''}
                    </Typography.Text>
                  ))}
                </Space>
              ),
            },
          ]}
        />
      )}

      {/* Перепроверка живёт рядом с талонами, а не отдельным экраном: разбирает её тот же
          человек и тем же правом, а расхождение двух чтений — такая же работа, как замечание. */}
      <BlindCheckPanel requestId={requestId} checks={data.blindChecks} />

      {scan && (
        <FilePreviewModal
          file={{ id: scan.fileId, filename: scan.filename, contentType: scan.contentType }}
          open
          onClose={() => setScan(null)}
        />
      )}

      <TicketFormModal
        requestId={requestId}
        ticket={form?.ticket ?? null}
        open={!!form}
        onClose={() => setForm(null)}
      />
    </Space>
  );
}
