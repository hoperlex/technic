-- Сквозной человекочитаемый номер заявки (identity). Отображается как «<num>-<буква типа>».
ALTER TABLE waste_requests ADD COLUMN num integer GENERATED ALWAYS AS IDENTITY;
CREATE UNIQUE INDEX waste_requests_num_unique ON waste_requests (num);
