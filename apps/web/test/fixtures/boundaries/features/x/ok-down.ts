/** Разрешено: features → entities через публичный вход слайса. */
import { objectsApi } from '@entities/object';

export const listObjects = () => objectsApi.list();
