import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export type Handler = (req: IncomingMessage, res: ServerResponse, body: string) => void;

export interface FixtureServer {
  /** `http://127.0.0.1:<port>` */
  origin: string;
  /** Every request the server received, in arrival order. A WebSocket upgrade is recorded with method `WS`. */
  requests: { method: string; url: string; body: string }[];
  close(): Promise<void>;
}

/**
 * An HTTP server on 127.0.0.1 with an OS-picked port. Routes are keyed by pathname (the query is
 * ignored for matching, kept in `requests`); unknown paths answer 404. WebSocket upgrades are
 * recorded and refused, so a test can tell whether a socket ever reached the network.
 */
export function startFixtureServer(routes: Record<string, Handler>): Promise<FixtureServer> {
  const requests: FixtureServer['requests'] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      const url = req.url ?? '/';
      requests.push({ method: req.method ?? '', url, body });
      const handler = routes[new URL(url, 'http://127.0.0.1').pathname];
      if (handler) handler(req, res, body);
      else {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('not found');
      }
    });
  });
  server.on('upgrade', (req, socket) => {
    requests.push({ method: 'WS', url: req.url ?? '/', body: '' });
    socket.destroy();
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        origin: `http://127.0.0.1:${port}`,
        requests,
        close: () =>
          new Promise<void>((done) => {
            server.closeAllConnections();
            server.close(() => done());
          }),
      });
    });
  });
}

/** A handler that answers 200 with an HTML body. */
export function html(body: string): Handler {
  return (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(body);
  };
}
