import { useEffect, useRef } from 'react';
import { Alert, Button, Space, Typography } from 'antd';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  ReceiptDraft,
  ReceiptRecognitionHealthDto,
  ReceiptRecognitionStateDto,
} from '@technic/contracts';
import { autoPartReceiptApi, autoPartReceiptKeys } from '@entities/auto-part-receipt';
import { formatMoney } from '../../utils/format';

/**
 * Чтение скана в окне «Принять чек» (план `docs/auto-part-receipt-ocr-plan.md`, §10).
 *
 * ПАНЕЛЬ НИЧЕГО НЕ СОХРАНЯЕТ. Она заполняет форму, и на этом её работа кончается: распознанное
 * живёт до нажатия «Сохранить», а сохранённый чек неотличим от набранного руками. Ни подтверждения
 * строк, ни статусов, ни очереди разбора у чека нет — сверять прочитанное не с чем, бумага сама
 * первоисточник.
 *
 * ВСЕ ЗАМЕЧАНИЯ ЖЁЛТЫЕ, и ни одно не мешает сохранить чек. Красного здесь нет вовсе: бумага бывает
 * с позициями, которых в портал не заносят, счёт бывает длиннее сотни строк, а скан — обрезанным.
 * Портал говорит, что видит, и оставляет решение человеку.
 *
 * ЗАЧЕМ ВООБЩЕ ПОКАЗЫВАТЬ ИТОГ С БУМАГИ, если поля итога у чека нет (Р11 плана чеков): именно он
 * ловит страницу, оставшуюся за кадром, и строку, которую модель пропустила (Р9). Число нигде не
 * сохраняется — оно живёт, пока открыта форма.
 */

/** Пока модель читает, окно спрашивает состояние каждые две секунды: страница идёт секунды. */
const POLL_MS = 2000;

function truncatedText(notes: ReceiptDraft['notes']): string | null {
  if (notes.droppedLines > 0) {
    return `Распознано ${notes.recognizedLines} позиций, в один чек помещается 100 — остальные заведите вторым чеком с тем же номером`;
  }
  if (notes.linesTruncated) {
    return 'Похоже, таблица обрезана кадром: снимите лист целиком или допишите позиции руками';
  }
  return null;
}

/**
 * Сходится ли сумма подставленных строк с «Итого» на бумаге (Р9).
 *
 * Сравнение в копейках: у двоичной дроби «3 512,19 + 1 250,35» даёт хвост, и прямое сравнение
 * ругалось бы на каждом втором чеке.
 */
function totalsText(notes: ReceiptDraft['notes']): string | null {
  if (notes.linesTotal === null) return null;
  const diff = Math.round(notes.linesTotal * 100) - Math.round(notes.draftTotal * 100);
  if (diff === 0) return null;
  return `На бумаге «Итого» ${formatMoney(notes.linesTotal)}, в подставленных строках ${formatMoney(notes.draftTotal)} — проверьте, все ли позиции попали в кадр`;
}

/** НДС сверх таблицы — не ошибка, а другой способ его начислить: подпись должна это различать. */
function vatText(notes: ReceiptDraft['notes']): string | null {
  if (notes.linesTotal === null || notes.documentTotal === null) return null;
  return Math.round(notes.documentTotal * 100) > Math.round(notes.linesTotal * 100)
    ? `«Всего к оплате» ${formatMoney(notes.documentTotal)} больше «Итого» ${formatMoney(notes.linesTotal)}: НДС начислен сверх таблицы`
    : null;
}

/** Что сказать про саму подсистему, когда скан не прочитался (§11 плана). */
function healthText(health: ReceiptRecognitionHealthDto): string {
  switch (health.state) {
    case 'disabled':
      return 'Распознавание чеков сейчас выключено — заполняйте форму руками.';
    case 'unconfigured':
      return `Сервис распознавания не настроен${health.code ? ` (${health.code})` : ''} — нужен администратор, само не восстановится.`;
    case 'degraded':
      return `Сервис распознавания сейчас недоступен: отказов за час ${health.failed} из ${health.attempts}. Попытки продолжатся сами.`;
    default:
      return '';
  }
}

export interface ReceiptRecognitionPanelProps {
  /** Скан, который читаем: последний добавленный в окне. `null` — сканов ещё нет. */
  fileId: string | null;
  /** Есть ли в форме набранное: от этого зависит, спрашивать ли перед заменой строк. */
  formFilled: boolean;
  onApply: (draft: ReceiptDraft) => void;
  disabled?: boolean;
}

export function ReceiptRecognitionPanel({
  fileId,
  formFilled,
  onApply,
  disabled = false,
}: ReceiptRecognitionPanelProps) {
  const queryClient = useQueryClient();
  const state = useQuery({
    queryKey: autoPartReceiptKeys.recognition(fileId ?? 'none'),
    queryFn: () => autoPartReceiptApi.recognition(fileId!),
    enabled: !!fileId,
    // Опрос живёт ровно столько, сколько идёт чтение: постоянный интервал держал бы запросы
    // открытым окном часами.
    refetchInterval: (query) =>
      (query.state.data as ReceiptRecognitionStateDto | undefined)?.status === 'pending'
        ? POLL_MS
        : false,
  });

  /**
   * Состояние подсистемы спрашивается ТОЛЬКО после неудачи: отказ на одном скане и нездоровье
   * сервиса — разные вещи, и объяснять первое вторым имеет смысл лишь тогда, когда второе есть.
   */
  const health = useQuery({
    queryKey: autoPartReceiptKeys.recognitionHealth(),
    queryFn: () => autoPartReceiptApi.recognitionHealth(),
    enabled: state.data?.status === 'failed',
  });

  const recognize = useMutation({
    mutationFn: (forced: boolean) => autoPartReceiptApi.recognize(fileId!, forced),
    onSuccess: (next) => {
      queryClient.setQueryData(autoPartReceiptKeys.recognition(next.fileId), next);
    },
  });

  /**
   * Свежезагруженный скан читается сам, без нажатия.
   *
   * `startedFor` — не оптимизация, а защита от круга: ответ ручки меняет состояние запроса, эффект
   * просыпается снова, и без метки «этот файл уже запускали» он ставил бы задачу на каждый ответ.
   * Мутации в зависимостях НЕТ намеренно: её объект пересоздаётся на каждый рендер и вешает экран.
   */
  const startedFor = useRef<string | null>(null);
  const status = state.data?.status;
  useEffect(() => {
    if (!fileId || disabled) return;
    if (status !== 'idle') return;
    if (startedFor.current === fileId) return;
    startedFor.current = fileId;
    recognize.mutate(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- см. комментарий выше про мутацию
  }, [fileId, status, disabled]);

  if (!fileId) return null;

  const data = state.data;
  const draft = data?.draft ?? null;
  const reading = data?.status === 'pending' || recognize.isPending;

  return (
    <Space orientation="vertical" size={8} style={{ width: '100%' }}>
      {reading && (
        <Alert
          type="info"
          showIcon
          title="Скан распознаётся — поля заполнятся сами"
          description="Окно можно заполнять и руками: распознанное ничего не затрёт без вашего согласия."
        />
      )}

      {data?.status === 'failed' && (
        <Alert
          type="warning"
          showIcon
          title="Распознать скан не удалось — заполните чек руками"
          description={
            <Space orientation="vertical" size={4}>
              <Typography.Text>
                {data.errorClass === 'terminal'
                  ? `${data.message} Автоматического повтора не будет.`
                  : `${data.message} Можно попробовать ещё раз.`}
              </Typography.Text>
              {/* Состояние подсистемы отличает «не прочитался этот скан» от «сервис не отвечает
                  никому»: во втором случае жать «Ещё раз» бессмысленно, и человек должен это
                  знать, а не выяснять нажатиями. */}
              {health.data && health.data.state !== 'ok' && (
                <Typography.Text type="secondary">{healthText(health.data)}</Typography.Text>
              )}
            </Space>
          }
          action={
            <Button size="small" disabled={disabled} onClick={() => recognize.mutate(true)}>
              Ещё раз
            </Button>
          }
        />
      )}

      {data?.status === 'unsupported' && (
        <Alert
          type="warning"
          showIcon
          title="Это не изображение и не PDF"
          description={data.message}
        />
      )}

      {data?.duplicate && (
        <Alert
          type="warning"
          showIcon
          title={`Этот скан уже подшит к чеку № ${data.duplicate.documentNumber} от ${data.duplicate.purchasedOn}`}
          description="Проверьте, не вносите ли покупку второй раз."
        />
      )}

      {draft && data?.status === 'done' && (
        <Alert
          type="success"
          showIcon
          title={`Распознано позиций: ${draft.lines.length}`}
          description={
            <Space orientation="vertical" size={4}>
              {[truncatedText(draft.notes), totalsText(draft.notes), vatText(draft.notes)]
                .filter((text): text is string => !!text)
                .map((text) => (
                  <Typography.Text key={text} type="warning">
                    {text}
                  </Typography.Text>
                ))}
              {data.processedPages < data.totalPages && (
                <Typography.Text type="warning">
                  {`В файле страниц: ${data.totalPages}, прочитано: ${data.processedPages}`}
                </Typography.Text>
              )}
            </Space>
          }
          action={
            <Space orientation="vertical" size={4}>
              <Button
                size="small"
                type="primary"
                disabled={disabled}
                onClick={() => {
                  // Набранное руками не затирается молча: спрашиваем ровно тогда, когда есть что
                  // терять, и не спрашиваем, когда форма пуста.
                  if (
                    !formFilled ||
                    window.confirm(`Заменить набранное распознанным (${draft.lines.length} строк)?`)
                  ) {
                    onApply(draft);
                  }
                }}
              >
                Заполнить форму
              </Button>
              <Button size="small" disabled={disabled} onClick={() => recognize.mutate(true)}>
                Распознать заново
              </Button>
            </Space>
          }
        />
      )}
    </Space>
  );
}
