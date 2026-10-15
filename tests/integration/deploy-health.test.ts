// The deploy's health check at its real 30 s (T069, AC-060, slice 23c-2): every other deploy test
// passes a shorter window through the command context. Each request has a total limit, so an app
// that drips its answer a byte a second cannot hold the deploy past about 30 s.
import { mkdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, onTestFinished } from 'vitest';
import { checkHealth } from '../../src/deploy/health.js';
import { tempDir } from '../helpers/keys.js';

const SYSTEMD = fileURLToPath(new URL('../helpers/systemd', import.meta.url));

describe('factory deploy: the health check (T069, AC-060, slice 23c-2)', () => {
  it('an app that drips its answer a byte a second is unhealthy within about 30 s: no answer', async () => {
    const server = createServer((_, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      const body = '{"status":"ok"}';
      let sent = 0;
      const drip = setInterval(() => {
        if (sent < body.length) res.write(body.charAt(sent++));
        else {
          clearInterval(drip);
          res.end();
        }
      }, 1000);
      res.on('close', () => {
        clearInterval(drip);
      });
    });
    await new Promise<void>((listening) => server.listen(0, '127.0.0.1', listening));
    onTestFinished(() => {
      server.closeAllConnections();
      server.close();
    });
    // The fake systemctl shows the unit active with this main process throughout.
    const home = tempDir();
    mkdirSync(join(home, '.fake-systemd'));
    writeFileSync(join(home, '.fake-systemd', 'app.service.pid'), '4242');
    const env = { HOME: home, PATH: `${SYSTEMD}:${process.env.PATH ?? ''}` };
    const { port } = server.address() as AddressInfo;

    const started = Date.now();
    const health = await checkHealth(port, { env, name: 'app.service', pid: '4242' });

    const took = Date.now() - started;
    expect(health).toEqual({ healthy: false, answer: 'GET /health: no answer within 30 s' });
    expect(took).toBeGreaterThanOrEqual(30_000);
    expect(took).toBeLessThan(32_000);
  }, 60_000);
});
