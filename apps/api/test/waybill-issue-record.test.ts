import { describe, expect, it } from 'vitest';
import { issueCheckOf } from '../src/services/waybill-issue-record';

/**
 * Reading `waybills.issue_warnings` for the journal (ADR 0108 item 21).
 *
 * The column is jsonb written by every issue path since migration 0136 and defaulted for the sheets
 * before it. The journal must keep the three states apart and must never read an envelope it does
 * not understand as «checked, all clean» — that is the one mistake the envelope exists to prevent.
 */
describe('проверка выписки в журнале листов', () => {
  it('умолчание колонки — «не проверялся»: лист выдан до колонки либо мимо рукопожатия', () => {
    expect(issueCheckOf({ schemaVersion: 1, status: 'not_checked' })).toEqual({
      status: 'not_checked',
      warnings: [],
    });
  });

  it('проверенный без предупреждений лист читается как «чисто», без списка', () => {
    expect(issueCheckOf({ schemaVersion: 1, status: 'clean' })).toEqual({
      status: 'clean',
      warnings: [],
    });
  });

  it('подтверждённые предупреждения отдаются текстом, кодом и предметом — без фактов и отпечатка', () => {
    const check = issueCheckOf({
      schemaVersion: 1,
      status: 'acknowledged',
      fingerprint: 'f'.repeat(64),
      warnings: [
        {
          facts: { code: 'driver_documents', personId: 'p-1', gaps: ['snils'] },
          message: 'У водителя Иванов И. И. не внесён СНИЛС',
          entities: ['Иванов И. И.'],
        },
        {
          facts: { code: 'blank_task' },
          message: 'В маршруте Р-12 нет заявок',
          entities: ['Р-12'],
        },
      ],
    });
    expect(check).toEqual({
      status: 'acknowledged',
      warnings: [
        {
          code: 'driver_documents',
          message: 'У водителя Иванов И. И. не внесён СНИЛС',
          entities: ['Иванов И. И.'],
        },
        { code: 'blank_task', message: 'В маршруте Р-12 нет заявок', entities: ['Р-12'] },
      ],
    });
    // The fingerprint and the person id are machine facts of the handshake, not the record a
    // person reads; the journal is open to scoped readers, and nobody needs them there.
    expect(JSON.stringify(check)).not.toContain('p-1');
    expect(JSON.stringify(check)).not.toContain('fff');
  });

  /*
   * An unreadable envelope is «not checked», never «clean»: the reader does not know what was
   * confirmed, and saying «nothing was wrong» about it would be a claim the record never made.
   */
  it('непонятный конверт читается «не проверялся», а не «чисто»', () => {
    for (const raw of [
      null,
      undefined,
      'clean',
      [],
      {},
      { status: 'clean' },
      { schemaVersion: 2, status: 'clean' },
      { schemaVersion: 1, status: 'approved' },
    ]) {
      expect(issueCheckOf(raw), JSON.stringify(raw)).toEqual({
        status: 'not_checked',
        warnings: [],
      });
    }
  });

  it('предупреждение без текста не превращается в пустую строку, а статус остаётся подтверждённым', () => {
    const check = issueCheckOf({
      schemaVersion: 1,
      status: 'acknowledged',
      fingerprint: 'x',
      warnings: [
        null,
        { facts: {}, message: '' },
        { message: 'Задание в листе пустое', entities: [1, 'Р-7'] },
      ],
    });
    expect(check).toEqual({
      status: 'acknowledged',
      warnings: [{ code: '', message: 'Задание в листе пустое', entities: ['Р-7'] }],
    });
  });
});
