import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Socket } from 'node:net';
import { once } from 'node:events';
import { ImapFlow } from 'imapflow';
import { connectMailbox } from '../server/adapters.js';
import { readConfig } from '../server/config.js';

// A deliberately tiny test server records the actual commands emitted by ImapFlow.
test(
  'IMAP wire: EXAMINE and BODY.PEEK, no Seen/STORE/MOVE/EXPUNGE',
  { timeout: 15000 },
  async (t) => {
    const commands: string[] = [],
      sockets = new Set<Socket>();
    const server = createServer((socket) => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
      socket.write('* OK FeedRelay test IMAP\r\n');
      let buffer = '';
      socket.on('data', (bytes) => {
        buffer += bytes.toString();
        while (buffer.includes('\r\n')) {
          const end = buffer.indexOf('\r\n'),
            line = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          commands.push(line);
          const [tag, command] = line.split(' '),
            upper = line.toUpperCase();
          const ok = (response = '') => socket.write(response + `${tag} OK complete\r\n`);
          if (command === 'CAPABILITY') ok('* CAPABILITY IMAP4rev1 ID\r\n');
          else if (command === 'LOGIN' || command === 'AUTHENTICATE') ok();
          else if (command === 'ID') ok('* ID NIL\r\n');
          else if (command === 'EXAMINE')
            ok('* FLAGS (\\Seen)\r\n* 1 EXISTS\r\n* OK [UIDVALIDITY 9]\r\n* OK [UIDNEXT 2]\r\n');
          else if (command === 'UID' && upper.includes('SEARCH')) ok('* SEARCH 1\r\n');
          else if (command === 'UID' && upper.includes('BODYSTRUCTURE'))
            ok(
              '* 1 FETCH (UID 1 BODYSTRUCTURE ("TEXT" "PLAIN" ("CHARSET" "UTF-8") NIL NIL "7BIT" 4 1))\r\n',
            );
          else if (command === 'UID' && upper.includes('BODY.PEEK')) {
            const parts: string[] = [];
            for (const match of upper.matchAll(/BODY\.PEEK\[([^\]]*)\](?:<(\d+)\.\d+>)?/g)) {
              const section = match[1],
                text =
                  section.includes('HEADER') || section.includes('MIME')
                    ? 'Content-Type: text/plain; charset=utf-8\r\n\r\n'
                    : 'news';
              const content = text.slice(Number(match[2] || 0));
              parts.push(
                `BODY[${section}]${match[2] !== undefined ? `<${match[2]}>` : ''} {${Buffer.byteLength(content)}}\r\n${content}`,
              );
            }
            ok(`* 1 FETCH (UID 1 ${parts.join(' ')})\r\n`);
          } else if (command === 'UID')
            ok(
              '* 1 FETCH (UID 1 INTERNALDATE "16-Oct-2026 08:00:00 +0000" ENVELOPE ("Fri, 16 Oct 2026 08:00:00 +0000" "Daily news" ((NIL NIL "brief" "example.com")) NIL NIL NIL NIL NIL NIL NIL))\r\n',
            );
          else if (command === 'LOGOUT') {
            socket.end(`* BYE\r\n${tag} OK logout\r\n`);
          } else ok();
        }
      });
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    t.after(() => {
      for (const socket of sockets) socket.destroy();
      server.close();
    });
    const config = readConfig({
      FEEDRELAY_DEMO: '1',
      IMAP_ENABLED: '1',
      IMAP_HOST: 'imap.163.com',
      IMAP_USER: 'test@163.com',
      IMAP_PASSWORD: 'synthetic',
    });
    const box = await connectMailbox(
      config,
      (options) =>
        new ImapFlow({
          ...options,
          host: '127.0.0.1',
          port: (server.address() as { port: number }).port,
          secure: false,
          doSTARTTLS: false,
          auth: { user: 'test', pass: 'synthetic', loginMethod: 'LOGIN' },
        }),
    );
    assert.equal((await box.headers(1, 1))[0].sender, 'brief@example.com');
    assert.equal(await box.body(1), 'news');
    await box.close();
    assert(commands.some((c) => / EXAMINE /.test(c)));
    assert(commands.some((c) => /BODY\.PEEK\[/.test(c)));
    assert(
      !commands.some((c) =>
        /\b(?:SELECT|STORE|MOVE|COPY|EXPUNGE|APPEND)\b|BODY\[|RFC822(?:\s|\))/.test(c),
      ),
    );
  },
);
