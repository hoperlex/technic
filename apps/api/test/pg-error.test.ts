import { describe, expect, it } from 'vitest';
import {
  isDbUnavailable,
  isQueryTimeout,
  markFromDatabase,
  pgErrorOf,
  QUERY_TIMEOUT_MESSAGE,
} from '../src/lib/pg-error';

/** drizzle's wrapper: the driver's error sits in `cause`, the outer message names the query. */
function wrapped(cause: unknown): Error {
  return new Error('Failed query: select 1\nparams: ', { cause });
}

function coded(code: string, message = 'boom'): Error {
  return Object.assign(new Error(message), { code });
}

/** An error as the database pool hands it out. */
function fromPool(error: Error): Error {
  markFromDatabase(error);
  return error;
}

describe('isDbUnavailable', () => {
  it.each([
    ['the query deadline', new Error(QUERY_TIMEOUT_MESSAGE)],
    ['the wait for a free client', new Error('timeout exceeded when trying to connect')],
    ['the connect deadline', new Error('Connection terminated due to connection timeout')],
    ['a dropped connection', new Error('Connection terminated unexpectedly')],
    ['a client ended after its deadline', new Error('Client was closed and is not queryable')],
    ['a reset socket', fromPool(coded('ECONNRESET'))],
    ['a refused connection', fromPool(coded('ECONNREFUSED'))],
    ['a resolver that could not answer', fromPool(coded('EAI_AGAIN'))],
    ['a broken pipe, five characters like a SQLSTATE', fromPool(coded('EPIPE'))],
    ["pg's own connect timer", fromPool(new Error('timeout expired'))],
    ['a server shutting down', coded('57P01')],
    ['a server still starting', coded('57P03')],
    ['a connection exception of class 08', coded('08006')],
    ['exhausted connection slots', coded('53300')],
  ])('recognises %s, bare and wrapped by drizzle', (_name, error) => {
    expect(isDbUnavailable(error)).toBe(true);
    expect(isDbUnavailable(wrapped(error))).toBe(true);
  });

  it.each([
    ['a uniqueness violation', coded('23505')],
    ['a statement cancelled by the server timeout', coded('57014')],
    ['an ordinary bug', new TypeError("Cannot read properties of undefined (reading 'id')")],
    // The same codes from S3, SMTP or the recognition proxy are not the database's.
    ['a refused S3 connection', coded('ECONNREFUSED', 'connect ECONNREFUSED 127.0.0.1:9')],
    ['a mail server that reset the socket', coded('ECONNRESET')],
    ['some other timer', new Error('timeout expired')],
    ['nothing at all', undefined],
  ])('leaves %s to the other handlers', (_name, error) => {
    expect(isDbUnavailable(error)).toBe(false);
    expect(isDbUnavailable(wrapped(error))).toBe(false);
  });

  it('does not hang on a cycle in the cause chain', () => {
    const a = new Error('a');
    const b = new Error('b', { cause: a });
    (a as { cause?: unknown }).cause = b;
    expect(isDbUnavailable(a)).toBe(false);
  });
});

describe('isQueryTimeout', () => {
  it('matches only the deadline itself, not other unavailability', () => {
    expect(isQueryTimeout(new Error(QUERY_TIMEOUT_MESSAGE))).toBe(true);
    expect(isQueryTimeout(new Error('Connection terminated unexpectedly'))).toBe(false);
  });
});

describe('pgErrorOf', () => {
  it('still finds the SQLSTATE under the drizzle wrapper', () => {
    expect(pgErrorOf(wrapped(coded('23505')))).toEqual({ code: '23505' });
  });
});
