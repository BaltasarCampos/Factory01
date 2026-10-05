import type { AddressInfo } from 'node:net';
import { afterAll, expect, it } from 'vitest';
import { createApp, openStore } from '../src/server.js';

const app = createApp(openStore(':memory:')).listen(0);
afterAll(() => app.close());

it('GET /health answers ok', async () => {
  const { port } = app.address() as AddressInfo;
  const res = await fetch(`http://127.0.0.1:${String(port)}/health`);
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ status: 'ok' });
});
