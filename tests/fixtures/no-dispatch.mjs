// Install before importing the CLI/MCP server to catch accidental hidden dispatch.
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import dns from 'node:dns';
import child from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
const deny = () => {
  throw new Error('OFFLINE_DISPATCH_FORBIDDEN');
};
globalThis.fetch = deny;
for (const [module, names] of [
  [http, ['request', 'get']],
  [https, ['request', 'get']],
  [net, ['connect', 'createConnection']],
  [dns, ['lookup', 'resolve', 'resolve4', 'resolve6']],
  [child, ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']],
])
  for (const name of names) module[name] = deny;
net.Socket.prototype.connect = deny;
for (const name of ['lookup', 'resolve', 'resolve4', 'resolve6']) dns.promises[name] = deny;
syncBuiltinESMExports();
