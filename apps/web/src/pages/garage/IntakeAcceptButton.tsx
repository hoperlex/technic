import { App, Button, Space, Tooltip, Typography } from 'antd';
import { CheckOutlined } from '@ant-design/icons';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { REPORT_ACCEPT_BATCH_LIMIT, type ReadingIntakeReport } from '@technic/contracts';
import { vehicleReadingKeys, vehicleReadingsApi } from '@entities/vehicle-reading';
import { errorMessage } from '@shared/lib';
import { useAuth } from '../../auth/AuthContext';

/**
 * Пакетный приём отчётов дня (план «Показания техники», Р8, Р9, Р9а).
 *
 * **Счёт идёт по отчётам периода, а не по видимым строкам.** `reports` приходит в ответе реестра
 * целиком — со счётчиками по всем строкам каждого отчёта, — и кнопка берёт из него те, где сервер
 * поставил `batchEligible`. Считай она по странице, и пагинация, разрезавшая отчёт пополам,
 * предложила бы принять день с невидимой жёлтой строкой (Р9а).
 *
 * **Принимается отчёт целиком** (Р8): день с одной жёлтой строкой уходит на разбор весь. Частичный
 * приём потребовал бы нового состояния в модели отчёта, а не кнопки на экране.
 *
 * **Итог показывается всегда, отказы — с причинами** (Р9). Пакет — это N транзакций, и отказ по
 * одному отчёту не отменяет приёма остальных: «принято 7 из 9» плюс причины по каждому
 * отказавшему — единственный честный ответ на такое действие. Причины приходят с сервера: версия
 * уехала, состояние сменилось, кто-то принял раньше — портал их показывает, а не сочиняет.
 */

/** Русское склонение счётного слова: 1 отчёт, 2 отчёта, 5 отчётов. */
function plural(n: number, one: string, few: string, many: string): string {
  const tens = n % 100;
  const ones = n % 10;
  if (tens >= 11 && tens <= 14) return many;
  if (ones === 1) return one;
  if (ones >= 2 && ones <= 4) return few;
  return many;
}

/** Остаток за потолком пакета: он не пропал, а ждёт следующего нажатия — так и сказано. */
function restHint(rest: number): string {
  return `Осталось ${rest} — примите их следующим нажатием`;
}

export function IntakeAcceptButton({ reports }: { reports: readonly ReadingIntakeReport[] }) {
  const { can } = useAuth();
  const { message, modal } = App.useApp();
  const qc = useQueryClient();

  /** Пригодность считает сервер по всему отчёту (Р9а) — портал её не выводит, а фильтрует по ней. */
  const eligible = reports.filter((report) => report.batchEligible);
  /*
   * Порция пакета. Потолок ручки (`REPORT_ACCEPT_BATCH_LIMIT`) — не формальность: пакет это N
   * последовательных транзакций, и неделя приёмки по большому парку способна набрать отчётов
   * больше потолка. Отправить всё разом означало бы получить отказ на весь список вместо приёма;
   * поэтому уходит порция, а остаток называется в итоге и принимается следующим нажатием.
   */
  const batch = eligible.slice(0, REPORT_ACCEPT_BATCH_LIMIT);

  const accept = useMutation({
    mutationFn: () =>
      vehicleReadingsApi.acceptBatch(
        batch.map((report) => ({ id: report.reportId, version: report.version })),
      ),
    onSuccess: (result) => {
      const sent = batch.length;
      const title = `Принято ${result.accepted.length} из ${sent}`;
      const rest = eligible.length - sent;

      if (result.failed.length > 0) {
        const names = new Map(batch.map((report) => [report.reportId, report.personName]));
        modal.info({
          title,
          width: 520,
          content: (
            <Space orientation="vertical" size={4} style={{ display: 'flex' }}>
              <Typography.Text type="secondary">
                Эти отчёты остались непринятыми — их состояние изменилось, пока реестр был открыт:
              </Typography.Text>
              {result.failed.map((failure) => (
                <Typography.Text key={failure.id}>
                  {names.get(failure.id) || 'Отчёт'} — {failure.reason}
                </Typography.Text>
              ))}
              {rest > 0 && <Typography.Text type="secondary">{restHint(rest)}</Typography.Text>}
            </Space>
          ),
        });
      } else {
        message.success(rest > 0 ? `${title}. ${restHint(rest)}` : title);
      }

      /*
       * Гасится корень слайса, а не ключ реестра (Р19). Приём меняет те же числа, которые
       * показывают сводка парка, карточка машины и журнал: оставь их на своих ключах — и
       * статистика, открытая рядом, показывала бы вчерашнее до перезагрузки страницы.
       */
      void qc.invalidateQueries({ queryKey: vehicleReadingKeys.root });
    },
    onError: (e) => message.error(errorMessage(e)),
  });

  // Право на приём своё: реестр читают под `vehicleReadings.read`, а принимают под write (§9).
  if (!can('vehicleReadings.write')) return null;

  const label = `Принять ${eligible.length} ${plural(eligible.length, 'отчёт', 'отчёта', 'отчётов')}`;
  const button = (
    <Button
      type="primary"
      icon={<CheckOutlined />}
      disabled={eligible.length === 0}
      loading={accept.isPending}
      onClick={() => accept.mutate()}
    >
      {label}
    </Button>
  );

  // Выключенная кнопка без объяснения читается как поломка: пакет берёт только те отчёты, где все
  // строки зелёные, и «ноль» здесь означает работу для разбора, а не отсутствие отчётов.
  return eligible.length === 0 ? (
    <Tooltip title="Пакетом принимаются отчёты, где зелены все строки. Остальные разбирают по одному">
      <span>{button}</span>
    </Tooltip>
  ) : (
    button
  );
}
