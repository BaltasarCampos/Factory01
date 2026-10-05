// Walking skeleton (TypeScript profile): an HTTP server with `/health`, one JSON log line per
// event, and a `node:sqlite` store. Define copies it into a new project; the product grows
// from here.
import { mkdirSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

export function log(level: 'info' | 'error', msg: string, fields: Record<string, unknown> = {}) {
  process.stdout.write(
    `${JSON.stringify({ ts: new Date().toISOString(), level, msg, ...fields })}\n`,
  );
}

/** The product's database; `:memory:` in tests. */
export function openStore(path: string): DatabaseSync {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  return db;
}

export function createApp(db: DatabaseSync): Server {
  return createServer((req, res) => {
    const healthy = req.method === 'GET' && req.url === '/health';
    if (healthy) db.prepare('SELECT 1').get();
    res.writeHead(healthy ? 200 : 404, { 'content-type': 'application/json' });
    res.end(JSON.stringify(healthy ? { status: 'ok' } : { error: 'not found' }));
    log('info', 'request', { method: req.method, url: req.url, status: res.statusCode });
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT ?? 3000);
  const app = createApp(openStore(process.env.DB_PATH ?? 'data/app.sqlite'));
  app.listen(port, () => {
    log('info', 'listening', { port });
  });
}
