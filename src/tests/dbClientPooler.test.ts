import net from 'node:net';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { SQL_CLIENT_OPTIONS } from '../db/client.js';

/**
 * Servidor Postgres falso que se comporta como o Supavisor antes da 2.10 em modo
 * transação: responde uma consulta por vez e, se o cliente começar outra
 * (Parse, Bind ou Query) antes de receber a resposta da anterior, a conexão
 * fica muda. Foi o que travou o painel ao gerar o diagnóstico em produção.
 */
function startSupavisorLikeServer() {
  const sockets = new Set<net.Socket>();
  let pipelinedConnections = 0;

  const message = (type: string, body: Buffer = Buffer.alloc(0)) => {
    const header = Buffer.alloc(5);
    header.write(type, 0, 'latin1');
    header.writeInt32BE(body.length + 4, 1);
    return Buffer.concat([header, body]);
  };
  const int32 = (value: number) => { const b = Buffer.alloc(4); b.writeInt32BE(value); return b; };
  const int16 = (value: number) => { const b = Buffer.alloc(2); b.writeInt16BE(value); return b; };
  const cstring = (value: string) => Buffer.from(`${value}\0`, 'utf8');
  // Uma coluna `x` int4 (oid 23), em texto.
  const rowDescription = message('T', Buffer.concat([
    int16(1), cstring('x'), int32(0), int16(0), int32(23), int16(4), int32(-1), int16(0),
  ]));
  const dataRow = message('D', Buffer.concat([int16(1), int32(1), Buffer.from('1')]));
  const ready = message('Z', Buffer.from('I'));

  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => socket.destroy());

    let buffer = Buffer.alloc(0);
    let started = false;
    let mute = false;
    let awaiting = 0; // pontos de resposta (Sync, Flush, Query) ainda sem resposta
    let pending: Buffer[] = [];

    const answer = (chunk: Buffer[], delayMs = 20) => {
      awaiting += 1;
      setTimeout(() => {
        awaiting -= 1;
        if (!mute && !socket.destroyed) socket.write(Buffer.concat(chunk));
      }, delayMs);
    };

    socket.on('data', (data) => {
      buffer = Buffer.concat([buffer, data]);
      for (;;) {
        if (!started) {
          if (buffer.length < 8) return;
          const length = buffer.readInt32BE(0);
          if (buffer.length < length) return;
          const code = buffer.readInt32BE(4);
          buffer = buffer.subarray(length);
          if (code === 80877102) { socket.destroy(); return; } // CancelRequest
          started = true;
          socket.write(Buffer.concat([message('R', int32(0)), message('K', Buffer.concat([int32(1), int32(1)])), ready]));
          continue;
        }
        if (buffer.length < 5) return;
        const type = String.fromCharCode(buffer[0]);
        const length = buffer.readInt32BE(1);
        if (buffer.length < length + 1) return;
        const body = buffer.subarray(5, length + 1);
        buffer = buffer.subarray(length + 1);

        if ('PBQ'.includes(type) && awaiting > 0 && !mute) {
          mute = true;
          pipelinedConnections += 1;
        }
        if (type === 'P') pending.push(message('1'));
        if (type === 'D') pending.push(...(body[0] === 0x53 ? [message('t', int16(0)), rowDescription] : [rowDescription]));
        if (type === 'B') pending.push(message('2'));
        if (type === 'E') pending.push(dataRow, message('C', cstring('SELECT 1')));
        if (type === 'H') { answer(pending); pending = []; }
        if (type === 'S') { answer([...pending, ready]); pending = []; }
        if (type === 'Q') answer([rowDescription, dataRow, message('C', cstring('SELECT 1')), ready]);
        if (type === 'X') socket.end();
      }
    });
  });

  return new Promise<{ url: string; pipelinedConnections: () => number; close: () => Promise<void> }>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `postgres://app:app@127.0.0.1:${port}/feedback`,
        pipelinedConnections: () => pipelinedConnections,
        close: () => new Promise((done) => {
          for (const socket of sockets) socket.destroy();
          server.close(() => done());
        }),
      });
    });
  });
}

/** Sete consultas juntas, como o `snapshotOf` do diagnóstico. */
function sevenConcurrentQueries(sql: postgres.Sql) {
  return Promise.allSettled(Array.from({ length: 7 }, (_, i) => sql`select ${i}::int as x`));
}

describe('Cliente do banco com o pooler do Supabase (modo transação)', () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => {
    while (cleanups.length) await cleanups.pop()!();
  });

  it('não manda consultas em pipeline: as sete consultas juntas respondem', async () => {
    const pooler = await startSupavisorLikeServer();
    const sql = postgres(pooler.url, SQL_CLIENT_OPTIONS);
    cleanups.push(pooler.close, () => sql.end({ timeout: 1 }));

    const results = await sevenConcurrentQueries(sql);

    expect(results.map((r) => r.status)).toEqual(Array(7).fill('fulfilled'));
    expect(pooler.pipelinedConnections()).toBe(0);
    expect(SQL_CLIENT_OPTIONS.max_pipeline).toBe(1);
  });

  it('com pipeline (padrão do postgres-js v4) o pooler trava, e o query_timeout faz falhar em vez de pendurar', async () => {
    const pooler = await startSupavisorLikeServer();
    // O mesmo cliente com o pipeline padrão, e o limite curto para o teste não esperar 15 s.
    const sql = postgres(pooler.url, { ...SQL_CLIENT_OPTIONS, max_pipeline: 100, query_timeout: 1, cancel_timeout: 1 });
    cleanups.push(pooler.close, () => sql.end({ timeout: 1 }));

    const results = await sevenConcurrentQueries(sql);

    expect(pooler.pipelinedConnections()).toBeGreaterThan(0);
    const failures = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(failures.length).toBeGreaterThan(0);
    expect(failures.every((r) => r.reason?.code === 'QUERY_TIMEOUT' || r.reason?.code === 'CONNECTION_DESTROYED')).toBe(true);
    expect(SQL_CLIENT_OPTIONS.query_timeout).toBeGreaterThan(0);
  }, 15_000);
});
