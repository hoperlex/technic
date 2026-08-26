#!/usr/bin/env python3
"""Сверка контрольного набора плана аудита распознавания талонов.

Числа в макетах — единственная ошибка этого плана, которую нельзя увидеть глазами: доля,
разошедшаяся со своим знаменателем, читается как настоящая. Поэтому макеты не проверяются
чтением — они разбираются отсюда и складываются.

Запуск: python3 docs/waste-ticket-audit-plan.check.py
Выход 0 — всё сходится, 1 — расхождение с указанием, где именно.
"""

import pathlib
import re
import sys

PLAN = pathlib.Path(__file__).parent / 'waste-ticket-audit-plan.md'
errors: list[str] = []


def check(ok: bool, message: str) -> None:
    if not ok:
        errors.append(message)


def find(pattern: str, text: str, what: str, flags: int = 0):
    m = re.search(pattern, text, flags)
    if m is None:
        errors.append(f'{what}: блок не найден — макет переписан, а проверка нет')
    return m


def main() -> int:
    s = PLAN.read_text(encoding='utf-8')

    # ── Строка исходов сводки: части обязаны складываться в целое ──
    m = find(r'Наблюдений (\d+) · решено (\d+) · ждут решения (\d+) · вытеснено (\d+) · снято (\d+)\n\s+потеряно (\d+) · вне разбора (\d+)', s, 'сводка')
    if m:
        total, *parts = map(int, m.groups())
        check(sum(parts) == total, f'сводка: {" + ".join(map(str, parts))} = {sum(parts)}, а заявлено {total}')

    # ── Таблица полей: исправления и знаменатели ──
    fields = re.findall(r'^(Номер|Дата|Объём|Вид работ|Адрес)\s+(\d+) / (\d+)\s+(\d+)%', s, re.M)
    check(len(fields) == 5, f'таблица полей сводки: строк {len(fields)}, ожидалось 5')
    corrected = sum(int(c) for _, c, _, _ in fields)
    denominator = sum(int(d) for _, _, d, _ in fields)
    for name, c, d, pct in fields:
        check(round(100 * int(c) / int(d)) == int(pct), f'{name}: {c}/{d} — это {round(100*int(c)/int(d))}%, а напечатано {pct}%')

    # ── Когорты конфигураций: сумма обязана равняться сводке ──
    cohorts = re.findall(r'^gemini[\w.\-]+\s+(?:gemini[\w.\-]+|—)\s+v3/п2\s+(\d+)\s+(\d+) / (\d+)\s+\S+\s+(\d+) / (\d+)', s, re.M)
    check(bool(cohorts), 'таблица когорт не распознана')
    if cohorts:
        check(sum(int(c) for _, c, _, _, _ in cohorts) == corrected,
              f'когорты: исправлений {sum(int(c) for _, c, _, _, _ in cohorts)}, в сводке {corrected}')
        check(sum(int(d) for _, _, d, _, _ in cohorts) == denominator,
              f'когорты: знаменатель {sum(int(d) for _, _, d, _, _ in cohorts)}, в сводке {denominator}')
        if m:
            check(sum(int(o) for *_, o in cohorts) == total,
                  f'когорты: наблюдений {sum(int(o) for *_, o in cohorts)}, всего {total}')

    # ── Каскад: исходы спора складываются в число споров ──
    disputes = find(r'создано споров\s+(\d+)', s, 'каскад')
    outcomes = [int(a or b) for a, b in re.findall(r'^    (?:оператор [^\n]*?\s+(\d+)|пока не решено\s+(\d+))$', s, re.M)]
    if disputes:
        check(sum(outcomes) == int(disputes.group(1)),
              f'каскад: исходы дают {sum(outcomes)}, а споров {disputes.group(1)}')

    # ── Точность: совпадения + арбитраж = знаменатель, и очереди не складываются лишний раз ──
    rows = re.findall(r'^(Номер|Дата|Объём)\s+(\d+) / (\d+)\s+(\d+)\s+(\d+)\s+данных', s, re.M)
    check(len(rows) == 3, f'таблица точности: строк {len(rows)}, ожидалось 3')
    right = sum(int(r) for _, r, _, _, _ in rows)
    n = sum(int(x) for _, _, x, _, _ in rows)
    matched = sum(int(x) for _, _, _, x, _ in rows)
    diverged = sum(int(x) for *_, x in rows)
    tot = find(r'Всего\s+(\d+) / (\d+)\s+(\d+) %', s, 'итог точности')
    if tot:
        check((right, n) == (int(tot.group(1)), int(tot.group(2))),
              f'точность: по полям {right}/{n}, а в итоге {tot.group(1)}/{tot.group(2)}')
        check(round(100 * right / n) == int(tot.group(3)),
              f'точность: {right}/{n} — это {round(100*right/n)}%, а напечатано {tot.group(3)}%')
    arb = find(r'Исходы расхождений \((\d+) разобрано, (\d+) ждут\)', s, 'исходы расхождений')
    if arb:
        resolved, waiting = int(arb.group(1)), int(arb.group(2))
        verdicts = [int(x) for x in re.findall(r'^  (?:права машина|прав проверяющий|ошиблись оба)\s+(\d+)$', s, re.M)]
        check(sum(verdicts) == resolved, f'исходы расхождений: {sum(verdicts)} против {resolved} разобранных')
        check(resolved + waiting == diverged, f'расхождений по полям {diverged}, а разобрано+ждут {resolved + waiting}')
        check(n == matched + resolved, f'знаменатель точности {n} ≠ совпадений {matched} + арбитража {resolved}')
    q = find(r'Выдано проверок (\d+): вернулись (\d+) \(из них (\d+) ждут арбитража\) · ждут проверяющего (\d+)', s, 'очереди проверок')
    if q:
        issued, returned, waits_arb, waits_check = map(int, q.groups())
        check(returned + waits_check == issued, f'очереди: {returned} + {waits_check} ≠ {issued}')
        if arb:
            check(waits_arb == int(arb.group(2)), 'очереди: «ждут арбитража» расходится с исходами расхождений')

    # ── Доверительный интервал Уилсона считается, а не пишется на глаз ──
    ci = find(r'\(интервал Уилсона (\d+)–(\d+) %, n = (\d+)\)', s, 'интервал Уилсона')
    if ci and tot:
        lo, hi, nn = map(int, ci.groups())
        check(nn == n, f'интервал: n = {nn}, а знаменатель {n}')
        z, p_hat = 1.959964, right / n
        d = 1 + z * z / n
        centre = (p_hat + z * z / (2 * n)) / d
        half = z / d * ((p_hat * (1 - p_hat) / n + z * z / (4 * n * n)) ** 0.5)
        check((round(100 * (centre - half)), round(100 * (centre + half))) == (lo, hi),
              f'интервал Уилсона для {right}/{n} — {round(100*(centre-half))}–{round(100*(centre+half))} %, '
              f'а напечатано {lo}–{hi} %')

    if errors:
        print('РАСХОЖДЕНИЯ:', file=sys.stderr)
        for e in errors:
            print(f'  · {e}', file=sys.stderr)
        return 1
    print(f'план сходится: наблюдений {total}, исправлений {corrected}/{denominator}, '
          f'точность {right}/{n}, споров {disputes.group(1)}')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
