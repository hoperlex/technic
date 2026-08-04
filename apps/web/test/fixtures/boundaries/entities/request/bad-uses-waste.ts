/** Запрещено: общее не должно знать о частном — иначе `request` перестанет быть общим. */
import { status } from '@entities/waste-request';

export const probe = status;
