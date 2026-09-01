#!/usr/bin/env python3
"""Generate vector pages for the waste-ticket audit decision visualisation.

The script intentionally uses only the Python standard library.  It writes one
SVG per page; the release PDF is assembled from those SVGs so that diagrams,
UI labels and small print stay sharp when zoomed or printed.

Usage:
    python3 docs/generate-waste-ticket-audit-visualization.py /tmp/waste-audit-pages
"""

from __future__ import annotations

import pathlib
import sys
import textwrap
from html import escape


W, H = 1120, 792
M = 54

NAVY = "#12233F"
INK = "#253858"
MUTED = "#66758F"
LINE = "#D9E2F0"
BG = "#F4F7FB"
WHITE = "#FFFFFF"
BLUE = "#1677FF"
BLUE_SOFT = "#EAF3FF"
CYAN = "#08979C"
CYAN_SOFT = "#E6FFFB"
GREEN = "#237B57"
GREEN_SOFT = "#EAF8F1"
AMBER = "#AD6800"
AMBER_SOFT = "#FFF7E6"
RED = "#B4232C"
RED_SOFT = "#FFF1F0"
PURPLE = "#6F42C1"
PURPLE_SOFT = "#F3EEFF"


class Page:
    def __init__(self, number: int, title: str, kicker: str):
        self.number = number
        self.nodes: list[str] = []
        self.nodes.append(
            f'<rect width="{W}" height="{H}" fill="{BG}"/>'
            '<defs>'
            '<marker id="arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto">'
            f'<path d="M0,0 L8,4 L0,8 Z" fill="{BLUE}"/></marker>'
            '<filter id="shadow" x="-20%" y="-20%" width="140%" height="140%">'
            '<feDropShadow dx="0" dy="3" stdDeviation="5" flood-color="#19345F" flood-opacity="0.10"/>'
            '</filter>'
            '</defs>'
        )
        self.text(M, 35, kicker.upper(), 11, BLUE, 700, letter=1.2)
        self.text(M, 68, title, 27, NAVY, 700)
        self.text(W - M, 36, f"{number:02d} / 07", 11, MUTED, 700, anchor="end")
        self.line(M, 86, W - M, 86, LINE, 1)

    def rect(
        self,
        x: float,
        y: float,
        w: float,
        h: float,
        fill: str = WHITE,
        stroke: str = "none",
        sw: float = 1,
        r: float = 14,
        shadow: bool = False,
        opacity: float = 1,
    ) -> None:
        filt = ' filter="url(#shadow)"' if shadow else ""
        self.nodes.append(
            f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="{r}" '
            f'fill="{fill}" fill-opacity="{opacity}" stroke="{stroke}" stroke-width="{sw}"{filt}/>'
        )

    def line(
        self,
        x1: float,
        y1: float,
        x2: float,
        y2: float,
        stroke: str = LINE,
        sw: float = 1,
        dash: str | None = None,
        arrow: bool = False,
    ) -> None:
        extra = f' stroke-dasharray="{dash}"' if dash else ""
        if arrow:
            extra += ' marker-end="url(#arrow)"'
        self.nodes.append(
            f'<line x1="{x1}" y1="{y1}" x2="{x2}" y2="{y2}" '
            f'stroke="{stroke}" stroke-width="{sw}"{extra}/>'
        )

    def circle(self, cx: float, cy: float, r: float, fill: str, stroke: str = "none", sw: float = 1) -> None:
        self.nodes.append(
            f'<circle cx="{cx}" cy="{cy}" r="{r}" fill="{fill}" stroke="{stroke}" stroke-width="{sw}"/>'
        )

    def path(self, d: str, fill: str = "none", stroke: str = INK, sw: float = 1.5) -> None:
        self.nodes.append(f'<path d="{d}" fill="{fill}" stroke="{stroke}" stroke-width="{sw}"/>')

    def text(
        self,
        x: float,
        y: float,
        value: str | list[str],
        size: float = 13,
        fill: str = INK,
        weight: int = 400,
        anchor: str = "start",
        line_height: float | None = None,
        family: str = "Noto Sans, DejaVu Sans, sans-serif",
        letter: float = 0,
    ) -> None:
        lines = [value] if isinstance(value, str) else value
        lh = line_height or size * 1.32
        attrs = (
            f'x="{x}" y="{y}" fill="{fill}" font-family="{family}" font-size="{size}" '
            f'font-weight="{weight}" text-anchor="{anchor}" letter-spacing="{letter}"'
        )
        if len(lines) == 1:
            self.nodes.append(f'<text {attrs}>{escape(lines[0])}</text>')
            return
        body = []
        for idx, line in enumerate(lines):
            dy = 0 if idx == 0 else lh
            body.append(f'<tspan x="{x}" dy="{dy}">{escape(line)}</tspan>')
        self.nodes.append(f'<text {attrs}>' + "".join(body) + "</text>")

    def para(
        self,
        x: float,
        y: float,
        value: str,
        width: float,
        size: float = 13,
        fill: str = INK,
        weight: int = 400,
        line_height: float | None = None,
    ) -> int:
        chars = max(8, int(width / (size * 0.56)))
        lines = textwrap.wrap(value, chars, break_long_words=False, break_on_hyphens=False)
        self.text(x, y, lines, size, fill, weight, line_height=line_height)
        return len(lines)

    def pill(
        self,
        x: float,
        y: float,
        label: str,
        fill: str = BLUE_SOFT,
        color: str = BLUE,
        w: float | None = None,
        h: float = 26,
        size: float = 11,
    ) -> float:
        width = w or max(58, 16 + len(label) * size * 0.56)
        self.rect(x, y, width, h, fill, "none", r=h / 2)
        self.text(x + width / 2, y + h * 0.68, label, size, color, 700, anchor="middle")
        return width

    def card_title(self, x: float, y: float, title: str, subtitle: str | None = None) -> None:
        self.text(x, y, title, 15, NAVY, 700)
        if subtitle:
            self.text(x, y + 21, subtitle, 10.5, MUTED, 400)

    def metric(
        self,
        x: float,
        y: float,
        w: float,
        label: str,
        value: str,
        note: str,
        color: str = BLUE,
    ) -> None:
        self.rect(x, y, w, 94, WHITE, LINE, 1, 12)
        self.text(x + 16, y + 23, label.upper(), 9.5, MUTED, 700, letter=0.7)
        self.text(x + 16, y + 56, value, 25, color, 700)
        self.text(x + 16, y + 78, note, 10.5, MUTED, 400)

    def footer(self, note: str = "Проектные макеты · контрольные данные плана") -> None:
        self.line(M, H - 30, W - M, H - 30, LINE, 1)
        self.text(M, H - 12, "Аудит распознавания талонов", 9.5, MUTED, 600)
        self.text(W / 2, H - 12, note, 9.5, MUTED, 400, anchor="middle")
        self.text(W - M, H - 12, "редакция 2.3 · 26.08.2026", 9.5, MUTED, 400, anchor="end")

    def save(self, path: pathlib.Path) -> None:
        svg = (
            f'<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{H}" viewBox="0 0 {W} {H}">'
            + "".join(self.nodes)
            + "</svg>"
        )
        path.write_text(svg, encoding="utf-8")


def step_box(p: Page, x: float, y: float, w: float, number: str, title: str, note: str, color: str) -> None:
    p.rect(x, y, w, 96, WHITE, LINE, 1, 14)
    p.circle(x + 27, y + 28, 16, color)
    p.text(x + 27, y + 33, number, 12, WHITE, 700, anchor="middle")
    p.text(x + 52, y + 27, title, 14, NAVY, 700)
    p.para(x + 18, y + 55, note, w - 36, 10.7, MUTED)


def browser_chrome(p: Page, x: float, y: float, w: float, h: float, active: str) -> None:
    p.rect(x, y, w, h, WHITE, LINE, 1, 13, shadow=True)
    p.rect(x, y, w, 36, NAVY, "none", r=13)
    p.rect(x, y + 22, w, 14, NAVY, "none", r=0)
    for i, color in enumerate(("#FF7A70", "#FFD166", "#54C987")):
        p.circle(x + 18 + i * 15, y + 18, 4.3, color)
    p.text(x + 70, y + 22, "Портал техники / Аудит талонов", 9.5, "#D9E7FB", 600)
    tabs = ["Сводка", "Когорты", "Лента", "Состояние", "Точность"]
    tx = x + 18
    for tab in tabs:
        tw = 54 + len(tab) * 3.2
        if tab == active:
            p.rect(tx, y + 47, tw, 27, BLUE_SOFT, "none", r=8)
            p.text(tx + tw / 2, y + 65, tab, 9.5, BLUE, 700, anchor="middle")
        else:
            p.text(tx + tw / 2, y + 65, tab, 9.5, MUTED, 600, anchor="middle")
        tx += tw + 4


def page_1() -> Page:
    p = Page(1, "Новые решения по аудиту талонов", "Карта решения")
    p.text(M, 117, "Сначала достоверный сбор. Затем убедительный интерфейс.", 17, NAVY, 600)
    p.text(M, 141, "Единица измерения, исходы и адресация фиксируются до первой плитки UI.", 12, MUTED)

    y = 172
    step_box(p, M, y, 300, "0", "Исправить сбор", "Наблюдение на каждое поле, фактические правки, версии и попытки.", RED)
    step_box(p, 410, y, 300, "✓", "Сверить числа", "Контрольный набор, SQL, DB-тесты и проверка макетов.", AMBER)
    step_box(p, 766, y, 300, "UI", "Открыть экраны", "Сводка, когорты, лента, состояние и точность.", BLUE)
    p.line(358, y + 48, 402, y + 48, BLUE, 2, arrow=True)
    p.line(714, y + 48, 758, y + 48, BLUE, 2, arrow=True)

    p.text(M, 300, "Три принципа, которые нельзя потерять в реализации", 16, NAVY, 700)
    cards = [
        (M, "Одно чтение поля", "Наблюдение — не талон и не правка. Пять полей одного талона дают пять независимых наблюдений.", BLUE_SOFT, BLUE, "01"),
        (392, "Решение ≠ оценка", "Правка меняет исход. Слепой арбитраж только оценивает и не переписывает производственную историю.", PURPLE_SOFT, PURPLE, "02"),
        (730, "Когорта по чтению", "Период применяется ко времени наблюдения: поздняя правка остаётся в исходной когорте.", CYAN_SOFT, CYAN, "03"),
    ]
    for x, title, body, bg, color, no in cards:
        p.rect(x, 323, 336, 145, WHITE, LINE, 1, 14)
        p.rect(x + 16, 340, 42, 42, bg, "none", r=11)
        p.text(x + 37, 367, no, 13, color, 700, anchor="middle")
        p.text(x + 72, 359, title, 14.5, NAVY, 700)
        p.para(x + 18, 407, body, 300, 11.2, MUTED)

    p.text(M, 508, "Контрольная выборка, на которой сходятся все экраны", 16, NAVY, 700)
    p.metric(M, 530, 232, "Наблюдений", "430", "86 разборов × 5 полей", BLUE)
    p.metric(304, 530, 232, "Исправлено", "52 / 357", "решённый знаменатель", RED)
    p.metric(554, 530, 232, "Споров", "15", "13 решены оператором", AMBER)
    p.metric(804, 530, 262, "Слепая проверка", "49 / 52", "94% · Уилсон 84–98%", GREEN)

    p.rect(M, 647, W - 2 * M, 76, NAVY, "none", r=14)
    p.text(M + 22, 675, "Главное ограничение", 11, "#9DC3FF", 700)
    p.text(M + 22, 703, "Точность смещена к неисправленным подтверждённым талонам — это подписано прямо на экране.", 14, WHITE, 600)
    p.pill(W - M - 154, 670, "НЕ ОБЩАЯ ТОЧНОСТЬ", "#263D60", "#CFE2FF", 132, 26, 9.5)
    p.footer()
    return p


def page_2() -> Page:
    p = Page(2, "Единица наблюдения и доменная адресация", "Модель данных")
    p.rect(M, 108, W - 2 * M, 84, NAVY, "none", r=15)
    p.text(M + 24, 139, "НАБЛЮДЕНИЕ", 10, "#9DC3FF", 700, letter=1)
    p.text(M + 24, 169, "одно машинное чтение · одного поля · одного талона · в одном разборе", 18, WHITE, 600)
    p.pill(W - M - 174, 132, "recognized / disputed", "#263D60", "#D7E8FF", 150, 28, 10)

    p.text(M, 227, "Откуда человеческое действие получает точную ссылку", 16, NAVY, 700)
    branches = [
        (M, "Правка или снятие", "Текущее наблюдение поля", "Та же транзакция и advisory lock", BLUE, BLUE_SOFT),
        (392, "Предложение", "Все 5 наблюдений + differs", "Связь записана при создании предложения", PURPLE, PURPLE_SOFT),
        (730, "Слепая проверка", "Baseline 3 проверяемых полей", "Связь снята в момент отбора", CYAN, CYAN_SOFT),
    ]
    for x, title, target, source, color, soft in branches:
        p.rect(x, 250, 336, 130, WHITE, LINE, 1, 14)
        p.rect(x + 16, 268, 5, 92, color, "none", r=3)
        p.text(x + 36, 282, title, 14, NAVY, 700)
        p.text(x + 36, 312, target, 12.2, color, 700)
        p.para(x + 36, 338, source, 275, 10.5, MUTED)

    p.line(222, 397, 222, 432, BLUE, 2, arrow=True)
    p.line(560, 397, 560, 432, BLUE, 2, arrow=True)
    p.line(898, 397, 898, 432, BLUE, 2, arrow=True)

    p.rect(M, 439, 650, 224, WHITE, LINE, 1, 14)
    p.card_title(M + 20, 468, "Журнал качества — источник истины", "Машинное событие хранит снимок конвейера")
    p.rect(M + 20, 506, 280, 126, BG, "none", r=10)
    p.text(M + 36, 530, "waste_ticket_field_events", 12, NAVY, 700, family="DejaVu Sans Mono")
    fields = [
        "id + field        UNIQUE",
        "read_state        read / unreadable / n/a",
        "primary / escalation / selected attempts",
        "models + prompt + preprocessing snapshots",
        "file_id + page_no + recognition_run_id",
    ]
    for i, row in enumerate(fields):
        p.text(M + 36, 554 + i * 15, row, 8.8, INK, 400, family="DejaVu Sans Mono")
    p.rect(M + 320, 506, 310, 126, BLUE_SOFT, "none", r=10)
    p.text(M + 338, 530, "Ссылочная целостность", 12, BLUE, 700)
    bullets = [
        "FK (observation_id, field)",
        "ON DELETE RESTRICT для наблюдения",
        "Попытки: SET NULL + снимки модели",
        "Чужое поле база отвергает сама",
    ]
    for i, row in enumerate(bullets):
        p.circle(M + 342, 554 + i * 18, 3.3, BLUE)
        p.text(M + 353, 558 + i * 18, row, 10.5, INK, 500)

    p.rect(732, 439, 334, 224, WHITE, LINE, 1, 14)
    p.card_title(752, 468, "Предложение переживает удаление", "Исход закрепляется событием")
    timeline_y = 535
    p.line(770, timeline_y, 1025, timeline_y, LINE, 4)
    for i, (label, color) in enumerate((("5 связей", PURPLE), ("5 событий", BLUE), ("delete", RED))):
        cx = 784 + i * 115
        p.circle(cx, timeline_y, 10, color)
        p.text(cx, timeline_y + 28, label, 10.5, color, 700, anchor="middle")
    p.text(752, 596, "differs хранится в момент чтения", 11, NAVY, 700)
    p.para(752, 619, "После решения связь уходит каскадом, но адресованное событие и исход остаются.", 286, 10.7, MUTED)

    p.rect(M, 684, W - 2 * M, 45, AMBER_SOFT, "none", r=10)
    p.text(M + 18, 712, "Узкое место:", 11.5, AMBER, 700)
    p.text(M + 111, 712, "принадлежность тому же талону и машинный тип события остаются служебными инвариантами — их держат DB-тесты.", 11.5, INK, 500)
    p.footer()
    return p


def page_3() -> Page:
    p = Page(3, "Исходы: честный знаменатель и строгий приоритет", "Словарь метрик")
    p.text(M, 118, "Доля исправлений отвечает на один вопрос: что изменил человек среди решённых обычным путём чтений?", 13, MUTED)

    p.rect(M, 148, 445, 142, NAVY, "none", r=16)
    p.text(M + 22, 177, "ДОЛЯ ИСПРАВЛЕНИЙ", 10, "#9DC3FF", 700, letter=1)
    p.text(M + 22, 222, "52", 34, WHITE, 700)
    p.text(M + 84, 221, "corrected", 13, "#FFB8B0", 600)
    p.line(M + 22, 237, M + 215, 237, "#4B6284", 1)
    p.text(M + 22, 267, "357 = corrected + accepted", 14, WHITE, 600)
    p.text(M + 310, 229, "15%", 38, "#7CC4FF", 700)
    p.text(M + 310, 257, "округлено", 10, "#B8C8DE", 400)

    p.rect(521, 148, 545, 142, WHITE, LINE, 1, 16)
    p.text(543, 177, "НЕ В ЗНАМЕНАТЕЛЕ", 10, MUTED, 700, letter=1)
    excluded = [
        ("13", "resolved_dispute", AMBER_SOFT, AMBER),
        ("3", "proposal_accepted", PURPLE_SOFT, PURPLE),
        ("20", "pending", BLUE_SOFT, BLUE),
        ("10", "superseded", BG, MUTED),
        ("15", "dismissed", RED_SOFT, RED),
        ("5", "lost", RED_SOFT, RED),
        ("7", "proposal: вне разбора", CYAN_SOFT, CYAN),
    ]
    x, y = 543, 195
    for idx, (num, label, bg, color) in enumerate(excluded):
        pw = 28 + len(label) * 6.1
        p.rect(x, y, pw, 28, bg, "none", r=14)
        p.text(x + 10, y + 19, num, 10.5, color, 700)
        p.text(x + 31, y + 19, label, 9.5, color, 600)
        x += pw + 8
        if (idx == 2) or x > 980:
            x = 543
            y += 36

    p.text(M, 328, "Приоритет определения исхода", 16, NAVY, 700)
    rules = [
        ("1", "Есть адресованное событие решения", "исход по событию + differs", BLUE),
        ("2", "Связано с живым предложением", "pending", PURPLE),
        ("3", "Появилось более новое наблюдение", "superseded", CYAN),
        ("4", "Талон подтверждён после чтения", "accepted", GREEN),
        ("5", "Талон ещё существует", "pending", AMBER),
        ("6", "Талона больше нет", "lost", RED),
    ]
    for i, (no, condition, outcome, color) in enumerate(rules):
        y = 353 + i * 48
        p.circle(M + 15, y + 15, 14, color)
        p.text(M + 15, y + 20, no, 10.5, WHITE, 700, anchor="middle")
        p.rect(M + 40, y, 430, 31, WHITE, LINE, 1, 8)
        p.text(M + 54, y + 21, condition, 11, INK, 600)
        p.line(M + 476, y + 15, M + 516, y + 15, color, 1.5, arrow=True)
        p.pill(M + 530, y + 2, outcome, (BLUE_SOFT if color == BLUE else BG), color, 170, 27, 10)

    p.rect(786, 328, 280, 313, WHITE, LINE, 1, 14)
    p.card_title(806, 357, "Матрица предложения", "Решение пишется до удаления")
    p.text(806, 400, "Событие", 10, MUTED, 700)
    p.text(916, 400, "differs", 10, MUTED, 700)
    p.text(980, 400, "Исход", 10, MUTED, 700)
    matrix = [
        ("proposal", "да", "принято", GREEN),
        ("proposal", "нет", "нет сигнала", CYAN),
        ("dismissed", "да", "не отнесено", AMBER),
        ("dismissed", "нет", "нет сигнала", CYAN),
    ]
    for i, (event, differs, outcome, color) in enumerate(matrix):
        yy = 419 + i * 43
        if i % 2 == 0:
            p.rect(800, yy - 4, 252, 35, BG, "none", r=6)
        p.text(806, yy + 17, event, 10, INK, 600, family="DejaVu Sans Mono")
        p.text(928, yy + 17, differs, 10, INK, 500)
        p.text(980, yy + 17, outcome, 9.5, color, 700)
    p.line(806, 592, 1045, 592, LINE, 1)
    p.para(806, 616, "Отклонение всего предложения не превращается в пять ошибок модели.", 232, 10.8, RED, 600)

    p.rect(M, 665, W - 2 * M, 64, PURPLE_SOFT, "none", r=12)
    p.text(M + 18, 691, "Арбитраж слепой проверки — событие оценки.", 12, PURPLE, 700)
    p.text(M + 18, 714, "Он не участвует в шести правилах и не меняет производственный исход задним числом.", 11.5, INK, 500)
    p.footer()
    return p


def page_4() -> Page:
    p = Page(4, "Сводка: решение для рабочего интерфейса", "UI · desktop + mobile")
    browser_chrome(p, M, 108, 760, 600, "Сводка")
    bx, by = M, 108
    p.text(bx + 18, by + 99, "27.07.2026 — 26.08.2026", 10.5, NAVY, 600)
    p.pill(bx + 610, by + 82, "Сбор с 26.08.2026", AMBER_SOFT, AMBER, 132, 25, 9)

    stats = [("430", "наблюдений", BLUE), ("373", "решено", GREEN), ("20", "ждут", AMBER), ("5", "потеряно", RED)]
    for i, (value, label, color) in enumerate(stats):
        x = bx + 18 + i * 180
        p.rect(x, by + 119, 164, 64, BG, "none", r=9)
        p.text(x + 12, by + 150, value, 21, color, 700)
        p.text(x + 62, by + 149, label, 9.8, MUTED, 600)

    p.text(bx + 18, by + 214, "Поле", 9, MUTED, 700)
    p.text(bx + 176, by + 214, "Исправлено", 9, MUTED, 700)
    p.text(bx + 330, by + 214, "Решено человеком", 9, MUTED, 700)
    p.text(bx + 510, by + 214, "Не прочитано", 9, MUTED, 700)
    p.text(bx + 650, by + 214, "Спорных", 9, MUTED, 700)
    rows = [
        ("Номер", "9 / 70", "13%", "4 / 86", "3 / 86", "5 / 86"),
        ("Дата", "6 / 72", "8%", "2 / 86", "1 / 86", "2 / 86"),
        ("Объём", "14 / 67", "21%", "7 / 86", "5 / 86", "8 / 86"),
        ("Вид работ", "2 / 74", "3%", "—", "0 / 86", "—"),
        ("Адрес", "21 / 74", "28%", "—", "2 / 86", "—"),
    ]
    for i, row in enumerate(rows):
        yy = by + 231 + i * 43
        p.rect(bx + 14, yy, 732, 35, WHITE if i % 2 else BG, "none", r=6)
        p.text(bx + 24, yy + 23, row[0], 10.3, NAVY, 600)
        p.text(bx + 176, yy + 23, row[1], 10.3, INK, 700)
        p.pill(bx + 238, yy + 6, row[2], BLUE_SOFT, BLUE, 45, 23, 9)
        p.text(bx + 330, yy + 23, row[3], 10.3, INK, 500)
        p.text(bx + 510, yy + 23, row[4], 10.3, INK, 500)
        p.text(bx + 650, yy + 23, row[5], 10.3, INK, 500)

    p.rect(bx + 18, by + 466, 724, 50, AMBER_SOFT, "none", r=8)
    p.text(bx + 32, by + 488, "Предложений 2", 10.5, AMBER, 700)
    p.text(bx + 142, by + 488, "принято 1 (3 поля) · отклонено 1", 10.5, INK, 500)
    p.text(bx + 32, by + 506, "Повторных правок: 8", 9.5, MUTED, 500)

    p.text(844, 113, "МОБИЛЬНАЯ КАРТОЧКА", 9.5, MUTED, 700, letter=0.8)
    p.rect(844, 132, 222, 348, WHITE, LINE, 1, 22, shadow=True)
    p.rect(856, 145, 198, 28, NAVY, "none", r=13)
    p.text(955, 164, "Аудит талонов", 9.5, WHITE, 600, anchor="middle")
    p.text(862, 198, "Объём", 13, NAVY, 700)
    p.text(862, 231, "14 / 67", 24, RED, 700)
    p.text(1044, 229, "21%", 16, RED, 700, anchor="end")
    p.line(862, 246, 1047, 246, LINE, 1)
    mobile_rows = [("Спорных", "8 / 86"), ("Не прочитано", "5 / 86 · 6%"), ("Решено человеком", "7 / 86 · 8%")]
    for i, (label, value) in enumerate(mobile_rows):
        yy = 276 + i * 48
        p.text(862, yy, label, 9.5, MUTED, 500)
        p.text(1044, yy, value, 10.5, INK, 700, anchor="end")
    p.rect(862, 420, 186, 38, BLUE_SOFT, "none", r=10)
    p.text(955, 444, "Открыть детали", 10, BLUE, 700, anchor="middle")

    p.rect(844, 504, 222, 204, WHITE, LINE, 1, 14)
    p.card_title(862, 530, "Четыре состояния")
    states = [
        ("Загрузка", "скелетон", BLUE),
        ("Ошибка", "повторить", RED),
        ("Пусто", "нет данных", MUTED),
        ("Данные", "таблица / карточки", GREEN),
    ]
    for i, (name, detail, color) in enumerate(states):
        yy = 552 + i * 34
        p.circle(866, yy + 7, 4, color)
        p.text(878, yy + 11, name, 10, INK, 600)
        p.text(1048, yy + 11, detail, 9.5, MUTED, 500, anchor="end")

    p.rect(M, 724, W - 2 * M, 35, BLUE_SOFT, "none", r=8)
    p.text(M + 14, 747, "Состояние фильтров живёт в URL · пустая выборка = «нет данных», не «0%» · абсолютные числа стоят перед процентами", 10.5, BLUE, 600)
    p.footer()
    return p


def page_5() -> Page:
    p = Page(5, "Лента событий и разбор по скану", "UI · диагностический контур")
    browser_chrome(p, M, 108, W - 2 * M, 604, "Лента")
    bx, by = M, 108
    p.text(bx + 18, by + 100, "Поле: все", 9.5, INK, 600)
    p.text(bx + 102, by + 100, "Тип: все", 9.5, INK, 600)
    p.text(bx + 186, by + 100, "Модель: flash-lite", 9.5, INK, 600)
    p.text(bx + 325, by + 100, "Промпт: v3", 9.5, INK, 600)
    p.rect(bx + 854, by + 80, 140, 30, BLUE, "none", r=8)
    p.text(bx + 924, by + 100, "Выгрузить CSV", 9.5, WHITE, 700, anchor="middle")

    p.rect(bx + 16, by + 128, 500, 446, BG, "none", r=10)
    p.text(bx + 32, by + 153, "26 августа", 10, MUTED, 700)
    feed = [
        ("14:12", "Объём", "правка", "3", "38", RED, True),
        ("13:58", "Номер", "не прочитано", "—", "—", AMBER, False),
        ("11:40", "Дата", "предложение отклонено", "14.08.2026", "14.08.2025", PURPLE, False),
        ("11:03", "Адрес", "правка", "ул. Ленина 5", "ул. Ленина, д. 5, корп. 2", RED, False),
    ]
    for i, (time, field, kind, old, new, color, selected) in enumerate(feed):
        yy = by + 166 + i * 94
        p.rect(bx + 26, yy, 480, 84, WHITE if not selected else BLUE_SOFT, BLUE if selected else LINE, 1, 9)
        p.text(bx + 40, yy + 22, time, 9.5, MUTED, 600)
        p.text(bx + 92, yy + 22, field, 11, NAVY, 700)
        p.pill(bx + 170, yy + 7, kind, RED_SOFT if color == RED else (PURPLE_SOFT if color == PURPLE else AMBER_SOFT), color, 156, 24, 8.8)
        p.text(bx + 40, yy + 49, "было", 8.5, MUTED, 500)
        p.text(bx + 83, yy + 49, old, 10, INK, 500)
        p.text(bx + 40, yy + 69, "стало", 8.5, MUTED, 500)
        p.text(bx + 83, yy + 69, new, 10, INK, 700)
        p.text(bx + 342, yy + 49, "flash-lite · v3/п2", 8.7, MUTED, 500)
        p.text(bx + 342, yy + 69, "Иванов И.", 8.7, MUTED, 500)

    p.rect(bx + 534, by + 128, 460, 446, WHITE, LINE, 1, 10)
    p.text(bx + 554, by + 156, "Скан талона · страница 2", 13, NAVY, 700)
    p.pill(bx + 865, by + 139, "PDF", RED_SOFT, RED, 48, 24, 9)
    p.rect(bx + 580, by + 178, 366, 274, "#F7F2E8", "#C8BFAE", 1, 5)
    p.text(bx + 763, by + 209, "КОНТРОЛЬНЫЙ ТАЛОН", 13, "#514A3F", 700, anchor="middle")
    p.line(bx + 604, by + 225, bx + 922, by + 225, "#BDB3A1", 1)
    scan_rows = [("Номер", "262"), ("Дата", "14.08.2026"), ("Вид работ", "Вывоз"), ("Объём, м³", "38")]
    for i, (label, value) in enumerate(scan_rows):
        yy = by + 255 + i * 43
        p.text(bx + 612, yy, label, 10, "#756B5C", 500)
        p.text(bx + 792, yy, value, 14, "#403A32", 700)
        p.line(bx + 606, yy + 11, bx + 916, yy + 11, "#D8D0C3", 1)
    p.rect(bx + 780, by + 365, 82, 34, "none", RED, 2, 4)
    p.rect(bx + 554, by + 476, 420, 78, BG, "none", r=9)
    p.text(bx + 570, by + 499, "Почему это важно", 10, NAVY, 700)
    p.para(bx + 570, by + 521, "Лента показывает оба значения, автора, модель и нужную страницу — отсюда рождаются правила промпта.", 385, 10, MUTED)

    p.rect(M, 727, 320, 34, GREEN_SOFT, "none", r=8)
    p.text(M + 12, 749, "Скан: только kind='ticket' · просмотр журналируется", 9.7, GREEN, 600)
    p.rect(386, 727, 308, 34, AMBER_SOFT, "none", r=8)
    p.text(398, 749, "CSV: ≤ 92 дней · ≤ 50 000 строк", 9.7, AMBER, 600)
    p.rect(706, 727, 360, 34, PURPLE_SOFT, "none", r=8)
    p.text(718, 749, "Формулы экранируются · факт выгрузки в audit_log", 9.7, PURPLE, 600)
    p.footer("Скан условный · значения соответствуют контрольному макету")
    return p


def page_6() -> Page:
    p = Page(6, "Два разных ответа: производственные сигналы и точность", "UI · не смешивать")
    p.pill(M, 106, "ЭКРАН 1", BLUE_SOFT, BLUE, 82, 25, 9)
    p.text(M + 96, 124, "Сигналы по производственным когортам", 15, NAVY, 700)
    p.pill(585, 106, "ЭКРАН 2", PURPLE_SOFT, PURPLE, 82, 25, 9)
    p.text(681, 124, "Точность среди неисправленных талонов", 15, NAVY, 700)

    p.rect(M, 145, 500, 506, WHITE, LINE, 1, 14, shadow=True)
    p.text(M + 20, 174, "Конфигурация конвейера", 11, MUTED, 700)
    cohort_rows = [
        ("flash-lite + 2.5-flash", "9", "6 / 33 · 18%", "2 / 45 · 4%"),
        ("flash-lite", "71", "41 / 298 · 14%", "8 / 355 · 2%"),
        ("2.5-flash", "6", "5 / 26 · n<30", "1 / 30 · 3%"),
    ]
    p.text(M + 24, 202, "Основная + эскалация", 9, MUTED, 700)
    p.text(M + 230, 202, "Разборов", 9, MUTED, 700)
    p.text(M + 315, 202, "Исправлено", 9, MUTED, 700)
    p.text(M + 424, 202, "Не проч.", 9, MUTED, 700)
    for i, row in enumerate(cohort_rows):
        yy = 216 + i * 47
        p.rect(M + 14, yy, 472, 39, BG if i % 2 == 0 else WHITE, "none", r=7)
        p.text(M + 24, yy + 25, row[0], 10, NAVY, 600)
        p.text(M + 250, yy + 25, row[1], 10, INK, 700)
        p.text(M + 315, yy + 25, row[2], 9.5, INK, 600)
        p.text(M + 424, yy + 25, row[3], 9.2, INK, 600)

    p.line(M + 20, 374, M + 480, 374, LINE, 1)
    p.text(M + 20, 402, "Каскад · эскалация включалась на 9 разборах", 12, NAVY, 700)
    cascade = [("Пустых после первого", 22, AMBER), ("Заполнено вторым", 14, GREEN), ("Создано споров", 15, RED)]
    for i, (label, value, color) in enumerate(cascade):
        yy = 424 + i * 42
        p.text(M + 24, yy + 17, label, 10.5, INK, 500)
        p.rect(M + 218, yy + 5, 210, 13, BG, "none", r=7)
        p.rect(M + 218, yy + 5, value * 8, 13, color, "none", r=7)
        p.text(M + 458, yy + 17, str(value), 10.5, color, 700, anchor="end")
    p.text(M + 24, 565, "Решение спора оператором", 9.5, MUTED, 700)
    p.text(M + 24, 588, "первый 6  ·  второй 5  ·  третье значение 2  ·  ждут 2", 10, INK, 600)
    p.rect(M + 20, 611, 460, 25, BLUE_SOFT, "none", r=7)
    p.text(M + 250, 628, "Сигнал, не A/B-тест: конфигурации видят разный поток", 9.2, BLUE, 600, anchor="middle")

    p.rect(585, 145, 481, 506, WHITE, LINE, 1, 14, shadow=True)
    p.rect(603, 164, 445, 68, AMBER_SOFT, "none", r=10)
    p.text(619, 188, "⚠ СМЕЩЁННАЯ ВЫБОРКА", 10, AMBER, 700)
    p.para(619, 209, "Не оценивает общую точность потока; результат ожидаемо оптимистичен.", 405, 10.2, INK, 600)
    p.text(609, 278, "94%", 48, PURPLE, 700)
    p.text(731, 267, "49 / 52", 16, NAVY, 700)
    p.text(731, 289, "Уилсон 84–98% · n=52", 10.5, MUTED, 500)
    p.text(609, 331, "Поле", 9, MUTED, 700)
    p.text(758, 331, "Верно", 9, MUTED, 700)
    p.text(840, 331, "Совпало", 9, MUTED, 700)
    p.text(943, 331, "Расхожд.", 9, MUTED, 700)
    blind_rows = [("Номер", "17 / 18", "16", "2"), ("Дата", "18 / 18", "17", "1"), ("Объём", "14 / 16", "14", "4")]
    for i, row in enumerate(blind_rows):
        yy = 346 + i * 42
        p.rect(599, yy, 449, 34, BG if i % 2 == 0 else WHITE, "none", r=6)
        p.text(609, yy + 22, row[0], 10.5, NAVY, 600)
        p.text(758, yy + 22, row[1], 10.5, INK, 700)
        p.text(862, yy + 22, row[2], 10.5, INK, 500)
        p.text(969, yy + 22, row[3], 10.5, INK, 500)
    p.text(609, 493, "Исходы 5 разобранных расхождений", 10.5, NAVY, 700)
    verdicts = [("права машина", "2", BLUE), ("прав проверяющий", "2", GREEN), ("ошиблись оба", "1", RED)]
    for i, (label, value, color) in enumerate(verdicts):
        yy = 514 + i * 31
        p.circle(614, yy + 6, 4, color)
        p.text(626, yy + 10, label, 10, INK, 500)
        p.text(1024, yy + 10, value, 10.5, color, 700, anchor="end")
    p.text(609, 625, "При n < 30 процент по полю не печатается", 9.5, MUTED, 500)

    p.line(560, 150, 560, 648, "#C9B7F5", 2, dash="5 7")
    p.rect(M, 678, W - 2 * M, 54, NAVY, "none", r=12)
    p.text(M + 18, 700, "НЕ СВОДИТЬ В ОДНУ ПЛИТКУ", 10, "#BDA9F3", 700, letter=0.8)
    p.text(M + 18, 720, "Подтверждение оператора — производственный сигнал; слепая проверка — независимая оценка. Это разные доказательства.", 11.2, WHITE, 600)
    p.footer()
    return p


def page_7() -> Page:
    p = Page(7, "Состояние подсистемы и безопасное внедрение", "Эксплуатация")
    p.rect(M, 108, W - 2 * M, 245, WHITE, LINE, 1, 14, shadow=True)
    p.text(M + 20, 139, "Состояние распознавания", 15, NAVY, 700)
    p.pill(M + 220, 119, "РАБОТАЕТ", GREEN_SOFT, GREEN, 94, 27, 9.5)
    p.text(W - M - 20, 139, "обновлено 14:19", 9.5, MUTED, 500, anchor="end")
    ops = [
        ("402", "вызова прокси", BLUE),
        ("11", "отказов", RED),
        ("37", "из кэша", CYAN),
        ("1 284 000", "токенов / 7 дней", PURPLE),
    ]
    for i, (value, label, color) in enumerate(ops):
        x = M + 20 + i * 245
        p.rect(x, 162, 225, 70, BG, "none", r=9)
        p.text(x + 14, 192, value, 20, color, 700)
        p.text(x + 14, 215, label, 9.8, MUTED, 600)
    p.line(M + 20, 251, W - M - 20, 251, LINE, 1)
    p.text(M + 20, 278, "Очередь", 10, MUTED, 700)
    p.text(M + 90, 278, "ждут 3 · выполняется 1 · упали 0 · мертвы 0 · старейшая 4 мин", 10.8, INK, 600)
    p.text(M + 20, 307, "Отказы", 10, MUTED, 700)
    p.text(M + 90, 307, "transient/subsystem 6 · terminal/item 4 · transient/item 1", 10.8, INK, 600)
    p.text(M + 20, 334, "Денег на экране нет — только измеряемые токены и фактические вызовы.", 9.8, BLUE, 600)

    p.text(M, 392, "Пять этапов — каждый заканчивается проверяемым результатом", 16, NAVY, 700)
    stages = [
        ("0", "Сбор", "словарь · миграция · тесты", RED),
        ("1", "Сводка", "право · ручка · первый UI", BLUE),
        ("2", "Когорты", "конвейер · каскад", CYAN),
        ("3", "Лента", "скан · CSV · audit_log", PURPLE),
        ("4", "Контроль", "состояние · точность", GREEN),
    ]
    for i, (no, title, note, color) in enumerate(stages):
        x = M + i * 204
        p.circle(x + 18, 431, 18, color)
        p.text(x + 18, 437, no, 12, WHITE, 700, anchor="middle")
        if i < len(stages) - 1:
            p.line(x + 42, 431, x + 194, 431, LINE, 3)
        p.text(x, 468, title, 13, NAVY, 700)
        p.para(x, 492, note, 175, 10, MUTED)

    p.rect(M, 555, 486, 156, WHITE, LINE, 1, 14)
    p.card_title(M + 18, 583, "Gate перед первым экраном", "Этап 0 нельзя перепрыгнуть")
    gates = [
        "collection_version = 2 только для новых событий",
        "контрольный SQL совпал с API и макетами",
        "гонки, предложения, уборка и FK покрыты тестами",
        "EXPLAIN ANALYZE на 200 000 событий",
    ]
    for i, item in enumerate(gates):
        yy = 629 + i * 22
        p.circle(M + 23, yy - 3, 6, GREEN_SOFT, GREEN, 1)
        p.text(M + 23, yy + 1, "✓", 8.5, GREEN, 700, anchor="middle")
        p.text(M + 38, yy + 1, item, 10, INK, 500)

    p.rect(558, 555, 508, 156, NAVY, "none", r=14)
    p.text(578, 583, "Доступ и след", 15, WHITE, 700)
    controls = [
        ("Право", "одноцелевой набор wasteRequests.ticketAudit"),
        ("Скан", "только ticket; доступ жив, пока жив файл"),
        ("CSV", "92 дня / 50 000 строк / защита формул"),
        ("Audit", "просмотры скана и выгрузки журналируются"),
    ]
    for i, (label, value) in enumerate(controls):
        yy = 612 + i * 22
        p.text(578, yy, label, 9.8, "#9DC3FF", 700)
        p.text(648, yy, value, 9.8, WHITE, 500)

    p.footer("Финальный контур решения · без функций изменения данных")
    return p


def main() -> int:
    out_dir = pathlib.Path(sys.argv[1]) if len(sys.argv) > 1 else pathlib.Path("/tmp/waste-ticket-audit-visualization-pages")
    out_dir.mkdir(parents=True, exist_ok=True)
    pages = [page_1(), page_2(), page_3(), page_4(), page_5(), page_6(), page_7()]
    for idx, page in enumerate(pages, 1):
        page.save(out_dir / f"waste-ticket-audit-{idx:02d}.svg")
    print(f"generated {len(pages)} SVG pages in {out_dir}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
