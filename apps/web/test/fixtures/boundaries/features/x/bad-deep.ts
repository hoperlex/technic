/** Запрещено: deep import внутрь чужого слайса мимо его index.ts. */
import { buildObjectQuery } from '@entities/object/api/internal';

export const query = buildObjectQuery();
