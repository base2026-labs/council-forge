import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { request as httpRequest } from 'node:http';

test(
  'offline console enforces Host, Origin, CSRF and has no live-run endpoint',
  { timeout: 10000 },
  async () => {
    const socket = createServer();
    socket.listen(0, '127.0.0.1');
    await once(socket, 'listening');
    const port = socket.address().port;
    await new Promise((resolve) => socket.close(resolve));
    const child = spawn(process.execPath, ['dist/web.js'], {
      env: { PATH: process.env.PATH, PORT: String(port) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    try {
      await new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('exit', () => reject(new Error('Console exited before readiness')));
        child.stdout.on('data', (data) => {
          if (String(data).includes('offline planning console:')) resolve();
        });
      });
      const url = `http://127.0.0.1:${port}`;
      const home = await fetch(url);
      assert.equal(home.status, 200);
      assert.match(home.headers.get('content-security-policy'), /frame-ancestors 'none'/);
      assert.match(await home.text(), /Council Forge/);
      const config = await (await fetch(url + '/api/config')).json();
      assert.equal(config.liveEnabled, false);
      assert.equal(
        (await fetch(url + '/api/config', { headers: { Origin: 'https://foreign.invalid' } }))
          .status,
        403,
      );
      const foreignHostStatus = await new Promise((resolve, reject) => {
        const request = httpRequest(
          url + '/api/config',
          { headers: { Host: 'foreign.invalid' } },
          (response) => {
            response.resume();
            resolve(response.statusCode);
          },
        );
        request.on('error', reject);
        request.end();
      });
      assert.equal(foreignHostStatus, 403);
      assert.equal((await fetch(url + '/api/demo', { method: 'POST', body: '{}' })).status, 403);
      const response = await fetch(url + '/api/demo', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-council-csrf': config.csrf },
        body: JSON.stringify(config.request),
      });
      const result = await response.json();
      assert.equal(response.status, 200);
      assert.equal(result.simulation, true);
      assert.equal(result.decision, 'hold');
      assert.equal(result.apiExposureUsd, 0);
      assert.equal((await fetch(url + '/api/run', { method: 'POST', body: '{}' })).status, 404);
    } finally {
      const exited = once(child, 'exit');
      child.kill();
      await exited;
    }
  },
);
