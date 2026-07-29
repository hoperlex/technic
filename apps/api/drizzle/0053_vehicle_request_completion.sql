-- Факт выполнения заявки ТС: отработанное время и стоимость (ADR 0029).
--
-- Назначение (ADR 0027) отвечает «чем и почём» — машина и ставка. Ответа «сколько в итоге
-- стоило» в портале не было: фактического времени работы он не вёл, и вкладка «История» могла
-- бы показать только план. Поэтому факт предъявляется при закрытии — тем же приёмом, каким
-- закрывается заявка на вывоз мусора (ADR 0011): вместе со сменой статуса, а не после неё.
--
-- Одна заявка — одно закрытие, поэтому request_id и есть первичный ключ: повторное закрытие
-- (после отката администратором) переписывает строку, второго факта на ту же заявку не бывает.

CREATE TYPE vehicle_work_unit AS ENUM ('hours', 'shifts');

CREATE TABLE vehicle_request_completions (
  request_id uuid PRIMARY KEY REFERENCES vehicle_requests (id) ON DELETE CASCADE,
  -- Чем мерили работу. Единица хранится рядом с количеством: «8» без неё не значит ничего,
  -- а одну и ту же заявку закрывают то часами (простой полдня), то сменами (аренда на неделю).
  worked_unit vehicle_work_unit NOT NULL,
  worked_amount numeric(10, 2) NOT NULL,
  -- Ставка, по которой считали, — снимок на момент закрытия, а не ссылка на назначение:
  -- повторный перевод в работу может её переписать, а закрытие обязано объяснить свою сумму
  -- («26 ч × 2 500 ₽»). NULL — у своей машины ставки не было вовсе (ADR 0027).
  rate numeric(12, 2),
  -- Итог. Считается ставкой на количество, но правится свободно: счёт арендодателя включает
  -- и перегон, и простой, а сумма в заявке должна сходиться со счётом, а не с формулой.
  -- NULL — считать было нечем: своя машина без ставки, и работу в деньгах не ведут.
  total_cost numeric(14, 2),
  completed_by uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  completed_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  -- Нулевая и отрицательная работа фактом не бывает; ставка положительна там, где задана.
  -- «Аренду без суммы не закрывают» — правило сервера: принадлежность машины лежит в vehicles,
  -- и CHECK её отсюда не видит (тем же образом устроена обязательность ставки в назначении).
  CONSTRAINT vehicle_request_completions_worked_amount_positive_check CHECK (worked_amount > 0),
  CONSTRAINT vehicle_request_completions_rate_positive_check CHECK (rate IS NULL OR rate > 0),
  CONSTRAINT vehicle_request_completions_total_cost_positive_check CHECK (
    total_cost IS NULL OR total_cost >= 0
  )
);

-- «Что закрыли за период и на какую сумму» — вопрос вкладки «История» ко всем закрытиям сразу.
CREATE INDEX vehicle_request_completions_completed_at_idx
  ON vehicle_request_completions (completed_at DESC);
