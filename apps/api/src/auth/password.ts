import { hash, verify } from '@node-rs/argon2';
import { config } from '../config';

// @node-rs/argon2 по умолчанию использует Argon2id — алгоритм не задаём явно,
// чтобы не обращаться к ambient const enum (isolatedModules).
const options = {
  memoryCost: config.auth.argon.memoryCost,
  timeCost: config.auth.argon.timeCost,
  parallelism: config.auth.argon.parallelism,
};

export function hashPassword(password: string): Promise<string> {
  return hash(password, options);
}

export function verifyPassword(passwordHash: string, password: string): Promise<boolean> {
  return verify(passwordHash, password);
}
