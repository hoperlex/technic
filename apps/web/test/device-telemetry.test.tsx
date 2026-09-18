import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import {
  DEVICE_TELEMETRY_PAGE_SIZE,
  type AuthUser,
  type DeviceEventDto,
  type DeviceMetricValueDto,
  type DeviceTelemetryCardDto,
} from '@technic/contracts';
import { json, mockHttp, type HttpMock, type RouteMap } from './http';
import { renderWithUser } from './render';
import { authUser } from './factories/auth';
import {
  DeviceTelemetryBlock,
  formatMetricValue,
  TELEMETRY_EMPTY_TEXT,
} from '../src/features/device-telemetry';

/**
 * Блок карточки «Показания и события» (план `docs/office-equipment-mail-telemetry-plan.md`, §10 и
 * §12) против замороженных DTO.
 *
 * Проверяется то, ради чего блок и написан именно так:
 *
 *   1. ПУСТОЕ СОСТОЯНИЕ — законный ответ, и оно названо словами. Блок встанет в карточки раньше
 *      первого письма, а у большей части парка писем не будет никогда: пустая таблица без
 *      объяснения читалась бы как поломка портала;
 *   2. РАЗРЕЗ — ЧАСТЬ ПОДПИСИ (Р33). У цветного аппарата «Остаток расходника» приходит четырьмя
 *      строками с разными числами, и без разреза три из них выглядели бы повтором четвёртой;
 *   3. ЛЕНТА ПОКАЗЫВАЕТ ВРЕМЯ АППАРАТА, а приём — только когда времени аппарата нет (Р21). Пачка
 *      писем, прочитанная за секунды после паузы, иначе рассказывала бы, что аппарат «замялся
 *      сорок раз только что»;
 *   4. У ПОКАЗАНИЯ ВСЁ НАОБОРОТ: отметка — приём порталом, названный вслух, и строка со сбитыми
 *      часами аппарата выглядит так же, как строка без времени аппарата вовсе. Обе развилки
 *      проверяются РАЗВЕДЁННЫМИ датами: совпади приём и время аппарата в фикстуре, оба случая
 *      проходили бы сами собой;
 *   5. ЧИСЛО БЕЗ ХВОСТА НУЛЕЙ: `value` приходит формой `numeric(18,3)`, и «12480.000 оттисков»
 *      читается как двести тысяч. Мок отдаёт именно ту форму, что и сервер, — прежний «12480»
 *      описывал ответ, которого не бывает, и дефект пропускал;
 *   6. страница с курсором: «Показать ещё» ДОПИСЫВАЕТ ленту, а метрики от догрузки не меняются —
 *      ручка одна на состояние и на ленту, и второй снимок метрик, подставленный на экран, человек
 *      прочитал бы как изменение показаний.
 */

const READER: AuthUser = authUser({
  role: 'shtab',
  constructionObjectIds: ['obj-1'],
  permissions: ['officeEquipment.read'],
});

function metric(over: Partial<DeviceMetricValueDto> = {}): DeviceMetricValueDto {
  return {
    metricCode: 'printed_impressions_total',
    component: '',
    // ФОРМА `numeric(18,3)`, А НЕ КРУГЛОЕ ЧИСЛО, и это находка ревью: мок с `'12480'` описывал
    // ответ, которого сервер не отдаёт НИКОГДА, и пропускал «12480.000 оттисков» на экран.
    value: '12480.000',
    unit: 'impressions',
    observedAt: '2026-09-15T06:00:00.000Z',
    // Время аппарата у показания НАРОЧНО уведено далеко от приёма: показанное вместо приёма, оно
    // объявило бы свежее число полугодовой давностью, а мутация «печатать `deviceTime`» без этого
    // расхождения прошла бы тест.
    deviceTime: '2026-02-01T05:58:00.000Z',
    source: 'email',
    ...over,
  };
}

function event(over: Partial<DeviceEventDto> = {}): DeviceEventDto {
  return {
    id: 'ev-1',
    eventCode: 'paper_jam',
    severity: 'warning',
    // Приём и время аппарата НАРОЧНО разведены на сутки: совпади они, случай 3 проходил бы сам
    // собой и ничего бы не доказывал.
    observedAt: '2026-09-16T10:00:00.000Z',
    deviceTime: '2026-09-15T08:30:00.000Z',
    source: 'email',
    vendorCode: 'SC552',
    text: 'Замятие в дуплексе',
    ...over,
  };
}

const card = (
  metrics: DeviceMetricValueDto[],
  events: DeviceEventDto[],
  nextCursor: string | null = null,
): DeviceTelemetryCardDto => ({
  metrics,
  events: { items: events, hasMore: nextCursor !== null, nextCursor },
});

function renderBlock(over: RouteMap = {}, user: AuthUser = READER): HttpMock {
  const http = mockHttp({
    'GET /office-equipment/:id/telemetry': () => json(card([metric()], [event()])),
    ...over,
  });
  renderWithUser(<DeviceTelemetryBlock equipmentId="oe-1" />, { user });
  return http;
}

describe('блок «Показания и события»', () => {
  it('пустой аппарат объясняет себя словами, а не пустой таблицей', async () => {
    renderBlock({ 'GET /office-equipment/:id/telemetry': () => json(card([], [])) });

    expect(await screen.findByText(TELEMETRY_EMPTY_TEXT)).toBeDefined();
    // Это именно «писем не было», а не «портал сломался»: причина названа, и из неё понятно, что
    // делать.
    expect(TELEMETRY_EMPTY_TEXT).toBe('Аппарат ещё не присылал писем');
  });

  it('последние значения подписаны метрикой и разрезом (Р33)', async () => {
    renderBlock({
      'GET /office-equipment/:id/telemetry': () =>
        json(
          card(
            [
              metric(),
              metric({
                metricCode: 'supply_level_percent',
                component: 'black',
                value: '40.000',
                unit: 'percent',
              }),
              metric({
                metricCode: 'supply_level_percent',
                component: 'yellow',
                value: '8.000',
                unit: 'percent',
              }),
            ],
            [],
          ),
        ),
    });

    expect(await screen.findByText('Напечатано оттисков')).toBeDefined();
    // Четыре тонера одного кода различает ТОЛЬКО разрез: без него обе строки звались бы одинаково.
    expect(screen.getByText('Остаток расходника · Чёрный')).toBeDefined();
    expect(screen.getByText('Остаток расходника · Жёлтый')).toBeDefined();
    // Хвоста нулей `numeric(18,3)` на экране нет: «12480.000 оттисков» читается как двести тысяч.
    expect(screen.getByText(/^12480 оттисков$/)).toBeDefined();
    expect(screen.getByText(/^8 %$/)).toBeDefined();
  });

  it('хвост нулей у числа не печатается, а настоящая дробь остаётся', () => {
    // Значащая дробь существует ради одного — процентов остатка тонера, — и её показать надо.
    expect(formatMetricValue('40.500')).toBe('40.5');
    expect(formatMetricValue('40.000')).toBe('40');
    expect(formatMetricValue('0.000')).toBe('0');
    // Восемнадцать знаков счётчика за жизнь аппарата: через `Number` они потеряли бы точность
    // ровно там, где колонка и заведена широкой.
    expect(formatMetricValue('123456789012345.000')).toBe('123456789012345');
    // Целое без точки и что угодно непонятное — как есть: обрезка не имеет права додумывать.
    expect(formatMetricValue('200')).toBe('200');
    expect(formatMetricValue('н/д')).toBe('н/д');
  });

  it('у показания стоит приём порталом, а не время аппарата (Р21)', async () => {
    renderBlock({
      'GET /office-equipment/:id/telemetry': () => json(card([metric()], [])),
    });

    // 15.09 09:00 по Москве — ПРИЁМ (06:00 UTC), и он назван вслух.
    expect(await screen.findByText(/принято 15\.09\.2026 09:00/)).toBeDefined();
    // Время аппарата (февраль) на экране не появляется: показанное как есть, оно объявило бы
    // свежее число полугодовой давностью — и неотличимо от строки, у которой показан приём.
    expect(screen.queryByText(/01\.02\.2026/)).toBeNull();
  });

  it('показание без времени аппарата выглядит так же, как и с ним', async () => {
    renderBlock({
      'GET /office-equipment/:id/telemetry': () => json(card([metric({ deviceTime: null })], [])),
    });

    // Ровно та же отметка и та же подпись: у показаний две строки не имеют права выглядеть
    // одинаково достоверными, означая разное, — поэтому у них один источник времени на все.
    expect(await screen.findByText(/принято 15\.09\.2026 09:00/)).toBeDefined();
  });

  it('лента показывает время аппарата, а не момент приёма', async () => {
    renderBlock();

    expect(await screen.findByText('Замятие бумаги')).toBeDefined();
    // 15.09 11:30 по Москве — время АППАРАТА (08:30 UTC). Приёма (16.09) на экране нет вовсе:
    // пачка писем, прочитанная за секунды, иначе показала бы сорок замятий «только что».
    expect(screen.getByText('15.09.2026 11:30')).toBeDefined();
    expect(screen.queryByText(/16\.09\.2026/)).toBeNull();
    expect(screen.queryByText('(приём)')).toBeNull();
  });

  it('без времени аппарата показывается приём, и это сказано вслух', async () => {
    renderBlock({
      'GET /office-equipment/:id/telemetry': () => json(card([], [event({ deviceTime: null })])),
    });

    expect(await screen.findByText('Замятие бумаги')).toBeDefined();
    // Подмена молчаливой быть не может: две строки ленты означали бы разное, а выглядели одинаково.
    expect(screen.getByText('(приём)')).toBeDefined();
    expect(screen.getByText(/16\.09\.2026 13:00/)).toBeDefined();
  });

  it('«Показать ещё» дозагружает ленту по курсору, не трогая показания', async () => {
    const http = renderBlock({
      'GET /office-equipment/:id/telemetry': ({ query }) =>
        json(
          query.get('cursor')
            ? card(
                // Вторая страница несёт СВОЙ снимок метрик — так устроена ручка. На экране обязан
                // остаться первый: иначе нажатие «Показать ещё» меняло бы показания.
                [metric({ value: '99999' })],
                [
                  event({
                    id: 'ev-2',
                    eventCode: 'toner_low',
                    severity: 'warning',
                    text: 'Мало тонера',
                  }),
                ],
              )
            : card([metric()], [event()], '1~device-events~2026-09-16T10:00:00.000000Z~ev-1'),
        ),
    });
    await screen.findByText('Замятие бумаги');

    fireEvent.click(screen.getByText('Показать ещё'));

    expect(await screen.findByText('Заканчивается тонер')).toBeDefined();
    // Первая страница осталась на месте: «показать ещё» дописывает, а не заменяет.
    expect(screen.getByText('Замятие бумаги')).toBeDefined();
    expect(screen.getByText(/^12480 оттисков$/)).toBeDefined();
    expect(screen.queryByText(/99999/)).toBeNull();

    await waitFor(() => expect(http.countOf('GET /office-equipment/:id/telemetry')).toBe(2));
    // Размер страницы называет портал: у блока он один и берётся из контракта.
    expect(http.calls[0]?.query.get('pageSize')).toBe(String(DEVICE_TELEMETRY_PAGE_SIZE));
  });
});
