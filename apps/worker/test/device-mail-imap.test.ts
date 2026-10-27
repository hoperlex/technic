import net from 'node:net';
import { ImapFlow } from 'imapflow';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createImapMailbox } from '../src/device-mail/mailbox-imap';
import { startDeviceMailPoller } from '../src/device-mail/poller';
import type { DeviceMailApi, DeviceMailConfig } from '../src/device-mail';

/**
 * The IMAP mailbox against a fake server on a real socket, so imapflow's own failure paths run: one
 * of them ended the prod worker on 22.10.2026, and a mock of the library would only restate our
 * guess about it. The fake speaks plain IMAP; the client factory below swaps TLS for plain TCP,
 * which production never does.
 *
 * `drop`: the server answers NAMESPACE and hangs up, so the session dies after login with COMPRESS
 * still ahead (the prod log). `mute-select`: the server never answers SELECT, the socket timeout
 * fires on an established session.
 */
type Behavior = 'healthy' | 'drop' | 'mute-select';

interface FakeImap {
  port: number;
  close: () => Promise<void>;
}

async function fakeImap(behaviorOf: (session: number) => Behavior): Promise<FakeImap> {
  const sockets = new Set<net.Socket>();
  let sessions = 0;
  const server = net.createServer((socket) => {
    const behavior = behaviorOf(++sessions);
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    socket.write('* OK [CAPABILITY IMAP4rev1 NAMESPACE COMPRESS=DEFLATE] fake ready\r\n');
    let buffer = '';
    socket.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('latin1');
      for (let end = buffer.indexOf('\r\n'); end >= 0; end = buffer.indexOf('\r\n')) {
        const [tag, command = ''] = buffer.slice(0, end).split(' ');
        buffer = buffer.slice(end + 2);
        switch (command.toUpperCase()) {
          case 'CAPABILITY':
            socket.write(`* CAPABILITY IMAP4rev1 NAMESPACE COMPRESS=DEFLATE\r\n${tag} OK done\r\n`);
            break;
          case 'NAMESPACE':
            socket.write(`* NAMESPACE (("" "/")) NIL NIL\r\n${tag} OK done\r\n`);
            if (behavior === 'drop') socket.end();
            break;
          case 'COMPRESS':
            // The healthy session declines, so no deflate layer is needed in the fake.
            socket.write(`${tag} NO not here\r\n`);
            break;
          case 'SELECT':
          case 'EXAMINE':
            if (behavior === 'mute-select') break;
            socket.write(
              `* 0 EXISTS\r\n* OK [UIDVALIDITY 7] ok\r\n* OK [UIDNEXT 1] ok\r\n${tag} OK [READ-WRITE] done\r\n`,
            );
            break;
          case 'LOGOUT':
            socket.end(`* BYE bye\r\n${tag} OK done\r\n`);
            break;
          default:
            socket.write(`${tag} OK done\r\n`);
        }
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    port: (server.address() as net.AddressInfo).port,
    close: () => {
      for (const socket of sockets) socket.destroy();
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

const config: DeviceMailConfig = {
  account: 'orgtech',
  transport: 'imap',
  dir: '',
  imapHost: 'imap.invalid',
  imapPort: 993,
  imapSecure: true,
  imapUser: 'user',
  imapPassword: 'secret',
  mailbox: 'INBOX',
  processedMailbox: '',
  pollIntervalMs: 300_000,
  batch: 50,
  maxSizeBytes: 1_000_000,
};

function plainClient(port: number) {
  return (options: ConstructorParameters<typeof ImapFlow>[0]) =>
    new ImapFlow({
      ...options,
      host: '127.0.0.1',
      port,
      secure: false,
      doSTARTTLS: false,
      // Short enough for a test; the production value is checked in the last case.
      socketTimeout: 300,
    });
}

const cursorApi: DeviceMailApi = {
  async cursor() {
    return {
      uidValidity: 7,
      lastUid: 0,
      resetUidValidity: null,
      resetMaxUid: null,
      stuckUidValidity: null,
      stuckUid: null,
      stuckAttempts: 0,
    };
  },
  async submit() {
    throw new Error('the fake mailbox is empty');
  },
};

// imapflow's stray error surfaces as an unhandled rejection or an uncaught exception, depending on
// the path; either one ends the worker process.
const escaped: unknown[] = [];
const onEscape = (e: unknown) => escaped.push(e);
let server: FakeImap | null = null;

beforeEach(() => {
  escaped.length = 0;
  process.on('unhandledRejection', onEscape);
  process.on('uncaughtException', onEscape);
});

afterEach(async () => {
  process.off('unhandledRejection', onEscape);
  process.off('uncaughtException', onEscape);
  await server?.close();
  server = null;
});

describe('IMAP mailbox of the device-mail intake', () => {
  it('keeps a session dropped before COMPRESS inside the tick instead of throwing it', async () => {
    server = await fakeImap(() => 'drop');
    const log = vi.fn();
    const mailbox = createImapMailbox(config, log, plainClient(server.port));

    await expect(mailbox.open()).rejects.toThrow();
    // The stray error comes after open() has already been rejected.
    await vi.waitFor(() =>
      expect(log).toHaveBeenCalledWith(
        expect.objectContaining({ code: 'NoConnection' }),
        'Ящик оргтехники: соединение оборвалось',
      ),
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(escaped).toEqual([]);
  });

  it('turns a server silent on SELECT into a failed open, not a folder hint or a crash', async () => {
    server = await fakeImap(() => 'mute-select');
    const log = vi.fn();
    const mailbox = createImapMailbox(config, log, plainClient(server.port));

    const failure = await mailbox.open().catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).not.toMatch(/Папка/);
    expect(log).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'ETIMEOUT' }),
      'Ящик оргтехники: соединение оборвалось',
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(escaped).toEqual([]);
  });

  it('loses one tick to a dropped session and reads the mailbox on the next', async () => {
    server = await fakeImap((session) => (session === 1 ? 'drop' : 'healthy'));
    const warn = vi.fn();
    const poller = startDeviceMailPoller({
      config,
      apiBaseUrl: 'http://api.invalid',
      internalToken: 'token',
      log: () => {},
      warn,
      api: cursorApi,
      mailbox: createImapMailbox(config, warn, plainClient(server.port)),
    });

    const first = await poller.tick();
    expect(first.mailboxError).toBeTruthy();
    const second = await poller.tick();
    expect(second.mailboxError).toBeUndefined();
    expect(second.taken).toBe(0);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(escaped).toEqual([]);
  });

  it('asks imapflow for a one-minute socket timeout and listens for its errors', async () => {
    let built: ImapFlow | null = null;
    const mailbox = createImapMailbox(
      config,
      () => {},
      (options) => {
        expect(options.socketTimeout).toBe(60_000);
        built = new ImapFlow({ ...options, host: '127.0.0.1', port: 9, secure: false });
        return built;
      },
    );
    await mailbox.open().catch(() => undefined);
    expect(built!.listenerCount('error')).toBeGreaterThan(0);
  });
});
