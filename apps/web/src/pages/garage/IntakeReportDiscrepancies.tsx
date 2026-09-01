import { useState } from 'react';
import { Button, Space, Tag, Typography } from 'antd';
import type { DiscrepancyKind, DriverReportDto, ReportDiscrepancyDto } from '@technic/contracts';
import { IntakeDiscrepancyModal } from './IntakeDiscrepancyModal';
import { IntakeRebaseModal } from './IntakeRebaseModal';

/**
 * Расхождения отчёта: чем снимок дня разошёлся с живым источником (ADR 0103, решение 10).
 *
 * Расхождения **не хранятся** — они вычисляются сравнением снимка строки ожидания с источником в
 * тот момент, когда отчёт спросили. Хранятся решения по ним, и действует последнее. Отсюда три
 * свойства этого блока:
 *
 * 1. **Текст приходит с сервера целиком** («рейс Р-142 переназначен Петрову П. П.»). Портал его не
 *    собирает и собрать не может: у него нет ни имени нового работника, ни прежней даты рейса — и
 *    выводить объяснение из одного вида расхождения значило бы сочинять.
 * 2. **Разобранное не исчезает.** Отпечаток обесценивает решение при смене сравниваемых полей, и
 *    строка, разобранная вчера, завтра может снова стать неразобранной. Поэтому показывается и
 *    исход, и причина, которую написал разбиравший, — иначе «расхождений нет» читалось бы как
 *    «их не было».
 * 3. **Решение меняется, а не «уже принято».** Журнал append-only: запись не правится, а
 *    перекрывается следующей, и действует последняя — по версии отчёта, а не по времени. Значит у
 *    разобранной строки кнопка остаётся, только зовётся иначе.
 *
 * Приведение снимка к источнику стоит здесь же, но отдельной кнопкой и только там, где ему есть что
 * переносить: у `driver`, `vehicle` и `date` предмет — строка ожидания, а `source_state` и
 * `missing_source` переносить нечего (источника нет вовсе либо нет строки).
 */

/** Виды, у которых снимок можно привести к источнику: остальным переносить нечего. */
const REBASABLE: readonly DiscrepancyKind[] = ['driver', 'vehicle', 'date'];

/** Ключ строки: отпечаток различает два расхождения одного вида лучше позиции в списке. */
const keyOf = (d: ReportDiscrepancyDto) =>
  `${d.kind}:${d.itemId ?? d.sourceId ?? ''}:${d.fingerprint}`;

export function IntakeReportDiscrepancies({
  report,
  canWrite,
}: {
  report: DriverReportDto;
  /** Право `vehicleReadings.write`: без него блок остаётся читающим. */
  canWrite: boolean;
}) {
  /** Разбираемое расхождение и переносимая строка — разные окна: у них разная цена нажатия. */
  const [resolving, setResolving] = useState<ReportDiscrepancyDto | null>(null);
  const [rebasing, setRebasing] = useState<(ReportDiscrepancyDto & { itemId: string }) | null>(
    null,
  );

  if (report.discrepancies.length === 0) return null;

  return (
    <Space orientation="vertical" size={6} style={{ display: 'flex' }}>
      <Typography.Text strong>Расхождения с заданием</Typography.Text>
      {report.discrepancies.map((d) => (
        <Space key={keyOf(d)} orientation="vertical" size={0}>
          <Space size={8} wrap>
            <Tag
              color={d.resolved ? 'default' : 'red'}
              style={{ whiteSpace: 'normal', marginInlineEnd: 0 }}
            >
              {d.message}
            </Tag>
            {canWrite && (
              <>
                {/* Разобранное разбирается заново: действует последнее решение, и «изменить» —
                    такая же запись журнала, как первая. */}
                <Button size="small" onClick={() => setResolving(d)}>
                  {d.resolved ? 'Изменить решение' : 'Разобрать'}
                </Button>
                {REBASABLE.includes(d.kind) && d.itemId !== null && (
                  /* Подпись называет последствие, а не действие: строка с показанием уедет в
                     чужой отчёт, и «Применить» обещало бы правку внутри этого дня. */
                  <Button
                    size="small"
                    danger
                    onClick={() => setRebasing({ ...d, itemId: d.itemId! })}
                  >
                    Привести снимок к источнику
                  </Button>
                )}
              </>
            )}
          </Space>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {d.resolved
              ? `разобрано: ${d.resolvedReason || 'без причины'}`
              : 'не разобрано — день не примут'}
          </Typography.Text>
        </Space>
      ))}

      {/*
       * Окна монтируются на время своего расхождения: у каждого свой предмет, свой отпечаток и своя
       * версия отчёта, а окно, живущее между открытиями, разбирало бы соседнюю строку.
       */}
      {resolving && (
        <IntakeDiscrepancyModal
          report={report}
          discrepancy={resolving}
          onClose={() => setResolving(null)}
        />
      )}
      {rebasing && (
        <IntakeRebaseModal
          report={report}
          discrepancy={rebasing}
          onClose={() => setRebasing(null)}
        />
      )}
    </Space>
  );
}
