import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import worker, { hasConnectorRole, semanticCardBody } from './index.js';

const workerSource = readFileSync(new URL('./index.js', import.meta.url), 'utf8');
const vueSource = readFileSync(new URL('../ui/src/App.vue', import.meta.url), 'utf8');
const uiStyles = readFileSync(new URL('../ui/src/styles.css', import.meta.url), 'utf8');
const winUiNotice = readFileSync(new URL('../ui/src/vendor/winui/NOTICE.md', import.meta.url), 'utf8');
const secretScript = readFileSync(new URL('../../bridge/scripts/message-secrets.ps1', import.meta.url), 'utf8');
assert.doesNotMatch(workerSource, /UPDATE connector_instances SET state = 'online'/);
assert.match(workerSource, /INSERT OR IGNORE INTO conversations/);
assert.match(workerSource, /conversation_type/);
assert.match(workerSource, /queue_class[^]*?'background'/);
assert.match(secretScript, /ConfigureConnectorTokens/);
assert.match(secretScript, /Invoke-WranglerSecretPut -Name 'CONNECTOR_TOKENS'/);
assert.match(secretScript, /StandardInput\.WriteLine\(\$Value\)/);
assert.match(secretScript, /command output was suppressed to protect secret material/);
assert.doesNotMatch(secretScript, /Write-Output[^\r\n]*(?:\$connectorCredential|ConvertTo-ConnectorTokensJson)/i);
for (const functionName of [
  'registerConnector',
  'heartbeatConnector',
  'ingestEvents',
  'ingestGroupTextBackups',
  'acknowledgeConnectorLayoutControl',
  'renewCommandLease',
  'completeCommand',
]) {
  const start = workerSource.indexOf(`async function ${functionName}(`);
  const end = workerSource.indexOf('\nasync function ', start + 1);
  const routeSource = workerSource.slice(start, end < 0 ? undefined : end);
  assert.ok(start >= 0);
  assert.ok(routeSource.indexOf('hasConnectorRole') < routeSource.indexOf('readJson'));
  assert.match(routeSource, /connector_id_mismatch/);
}

const adminToken = 'a'.repeat(40);
const agentToken = 'b'.repeat(40);
const connectorAToken = 'c'.repeat(40);
const connectorBToken = 'd'.repeat(40);
const legacyConnectorToken = 'e'.repeat(40);
const connectorAId = 'connector-a-primary';
const connectorBId = 'connector-b-primary';
const assetBodies = new Map([
  ['/index.html', ['<!doctype html><html lang="zh-CN"><head><link rel="stylesheet" href="/assets/app.css"></head><body><div id="app"></div><script type="module" src="/assets/app.js"></script></body></html>', 'text/html; charset=utf-8']],
  ['/assets/app.js', ['console.log("message-center-vue")', 'text/javascript; charset=utf-8']],
  ['/assets/app.css', [':root{color-scheme:light dark}', 'text/css; charset=utf-8']],
  ['/vendor/winui/NOTICE.md', [winUiNotice, 'text/markdown; charset=utf-8']],
]);
const env = {
  ADMIN_TOKEN: adminToken,
  AGENT_TOKEN: agentToken,
  ASSETS: {
    async fetch(request) {
      const value = assetBodies.get(new URL(request.url).pathname);
      return value ? new Response(value[0], { headers: { 'content-type': value[1] } }) : new Response('not found', { status: 404 });
    },
  },
};
const ctx = {};

const connectorTokenEnv = {
  CONNECTOR_TOKEN: legacyConnectorToken,
  CONNECTOR_TOKENS: JSON.stringify({
    [connectorAId]: connectorAToken,
    [connectorBId]: connectorBToken,
  }),
};
const connectorARequest = new Request('https://message.example.com/api/connectors/heartbeat', {
  headers: { authorization: `Bearer ${connectorAToken}` },
});
assert.equal(await hasConnectorRole(connectorARequest, connectorTokenEnv, connectorAId), true);
assert.equal(await hasConnectorRole(connectorARequest, connectorTokenEnv, connectorBId), false);
assert.equal(await hasConnectorRole(
  new Request('https://message.example.com/api/connectors/heartbeat', {
    headers: { authorization: `Bearer ${legacyConnectorToken}` },
  }),
  connectorTokenEnv,
  connectorAId,
), false);
assert.equal(await hasConnectorRole(
  new Request('https://message.example.com/api/connectors/heartbeat', {
    headers: { authorization: `Bearer ${legacyConnectorToken}` },
  }),
  { CONNECTOR_TOKEN: legacyConnectorToken, LEGACY_CONNECTOR_ID: connectorAId },
  connectorAId,
), true);
assert.equal(await hasConnectorRole(
  new Request('https://message.example.com/api/connectors/heartbeat', {
    headers: { authorization: `Bearer ${legacyConnectorToken}` },
  }),
  { CONNECTOR_TOKEN: legacyConnectorToken, LEGACY_CONNECTOR_ID: connectorAId },
  connectorBId,
), false);
assert.equal(await hasConnectorRole(
  new Request('https://message.example.com/api/connectors/heartbeat', {
    headers: { authorization: `Bearer ${legacyConnectorToken}` },
  }),
  { CONNECTOR_TOKEN: legacyConnectorToken },
  connectorAId,
), false);
assert.equal(await hasConnectorRole(
  new Request('https://message.example.com/api/connectors/heartbeat', {
    headers: { authorization: `Bearer ${legacyConnectorToken}` },
  }),
  { CONNECTOR_TOKEN: legacyConnectorToken, CONNECTOR_TOKENS: '{invalid-json' },
  connectorAId,
), false);
assert.equal(await hasConnectorRole(
  connectorARequest,
  { CONNECTOR_TOKENS: JSON.stringify({ [connectorAId]: connectorAToken, [connectorBId]: connectorAToken }) },
  connectorAId,
), false);

const connectorImpersonation = await worker.fetch(new Request(
  'https://message.example.com/api/connectors/register',
  {
    method: 'POST',
    headers: {
      authorization: `Bearer ${connectorAToken}`,
      'content-type': 'application/json',
      'x-connector-id': connectorBId,
    },
    body: JSON.stringify({
      id: connectorBId,
      kind: 'device',
      accountLabel: 'B',
      displayName: 'B',
      capabilities: ['receive_text'],
    }),
  },
), connectorTokenEnv, ctx);
assert.equal(connectorImpersonation.status, 401);

const connectorBodyMismatch = await worker.fetch(new Request(
  'https://message.example.com/api/connectors/register',
  {
    method: 'POST',
    headers: {
      authorization: `Bearer ${connectorAToken}`,
      'content-type': 'application/json',
      'x-connector-id': connectorAId,
    },
    body: JSON.stringify({
      id: connectorBId,
      kind: 'device',
      accountLabel: 'B',
      displayName: 'B',
      capabilities: ['receive_text'],
    }),
  },
), connectorTokenEnv, ctx);
assert.equal(connectorBodyMismatch.status, 403);
assert.equal((await connectorBodyMismatch.json()).error, 'connector_id_mismatch');

assert.equal(semanticCardBody('[转账] ¥1.00 · test'), true);
assert.equal(semanticCardBody('[拍一拍] A 拍了拍 B'), true);
assert.equal(semanticCardBody('[卡片] title'), true);
assert.equal(semanticCardBody('[file:asset]'), false);
assert.equal(semanticCardBody('ordinary message'), false);

const health = await worker.fetch(new Request('https://message.example.com/healthz'), env, ctx);
assert.equal(health.status, 200);
assert.equal(health.headers.get('cache-control'), 'no-store');
assert.deepEqual((await health.json()).storage, ['D1', 'R2']);

const denied = await worker.fetch(new Request('https://message.example.com/'), env, ctx);
assert.equal(denied.status, 303);
assert.equal(denied.headers.get('location'), '/login');

const loginPage = await worker.fetch(new Request('https://message.example.com/login'), env, ctx);
assert.equal(loginPage.status, 200);
assert.match(loginPage.headers.get('content-security-policy'), /form-action 'self'/);
const loginHtml = await loginPage.text();
assert.match(loginHtml, /type="password"/);
assert.doesNotMatch(loginHtml, /欢迎回来|Unified messaging workspace|管理员密码安全登录|HTTPS 传输/);
const csrfToken = loginHtml.match(/name="csrf" value="([^"]+)"/)?.[1];
assert.ok(csrfToken);

const crossOriginLogin = await worker.fetch(new Request('https://message.example.com/api/auth/login', {
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded', origin: 'https://attacker.example' },
  body: new URLSearchParams({ password: adminToken, csrf: csrfToken }),
}), env, ctx);
assert.equal(crossOriginLogin.status, 403);

const wrongPassword = 'wrong-password-that-is-long-enough-to-submit';
const wrongLogin = await worker.fetch(new Request('https://message.example.com/api/auth/login', {
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded', origin: 'https://message.example.com' },
  body: new URLSearchParams({ password: wrongPassword, csrf: csrfToken }),
}), env, ctx);
assert.equal(wrongLogin.status, 401);
assert.equal(wrongLogin.headers.get('set-cookie'), null);
assert.doesNotMatch(await wrongLogin.text(), new RegExp(wrongPassword));

const login = await worker.fetch(new Request('https://message.example.com/api/auth/login', {
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded', origin: 'null' },
  body: new URLSearchParams({ password: adminToken, csrf: csrfToken }),
}), env, ctx);
assert.equal(login.status, 303);
assert.equal(login.headers.get('location'), '/app');
const setCookie = login.headers.get('set-cookie');
assert.match(setCookie, /^__Host-message_session=/);
assert.match(setCookie, /HttpOnly/);
assert.match(setCookie, /Secure/);
assert.match(setCookie, /SameSite=Strict/);
const sessionCookie = setCookie.split(';', 1)[0];

const sessionPage = await worker.fetch(new Request('https://message.example.com/app', {
  headers: { cookie: sessionCookie },
}), env, ctx);
assert.equal(sessionPage.status, 200);
assert.match(sessionPage.headers.get('cache-control'), /no-store/);
assert.match(sessionPage.headers.get('content-security-policy'), /script-src 'self'/);
const sessionHtml = await sessionPage.text();
assert.match(sessionHtml, /<div id="app"><\/div>/);
assert.doesNotMatch(sessionHtml, /密码会话|Cloudflare Worker|Unified messaging workspace/);

const forgedSession = await worker.fetch(new Request('https://message.example.com/app', {
  headers: { cookie: `${sessionCookie}tampered` },
}), env, ctx);
assert.equal(forgedSession.status, 303);
assert.equal(forgedSession.headers.get('location'), '/login');

const logout = await worker.fetch(new Request('https://message.example.com/api/auth/logout', {
  method: 'POST',
  headers: { cookie: sessionCookie, origin: 'https://message.example.com' },
}), env, ctx);
assert.equal(logout.status, 303);
assert.equal(logout.headers.get('location'), '/login');
assert.match(logout.headers.get('set-cookie'), /Max-Age=0/);

const page = await worker.fetch(new Request('https://message.example.com/', {
  headers: { authorization: `Bearer ${adminToken}` },
}), env, ctx);
assert.equal(page.status, 200);
assert.match(page.headers.get('content-security-policy'), /script-src 'self'/);
const appHtml = await page.text();
assert.match(appHtml, /type="module" src="\/assets\/app.js"/);
assert.match(vueSource, /<dt>账号<\/dt><dd>/);
assert.match(vueSource, /<dt>渠道<\/dt><dd>/);
assert.match(vueSource, /<dt>ID<\/dt><dd/);
assert.match(vueSource, /<dt>模式<\/dt><dd/);
assert.match(vueSource, /<dt>能力<\/dt>/);
assert.match(vueSource, /自动恢复布局/);
assert.match(vueSource, /role="switch"/);
assert.match(vueSource, /expectedRevision/);
assert.match(vueSource, /refresh: String\(Date\.now\(\)\)/);
assert.match(vueSource, /visibilitychange/);
assert.match(vueSource, /pageshow/);
assert.doesNotMatch(vueSource, /deliveryState|trustTier|\breceived\b|Cloudflare Worker/);
assert.match(uiStyles, /--accent-base/);
assert.match(uiStyles, /\.toggle-switch/);
assert.match(winUiNotice, /Furry-Xiyi\/WinUIonWeb/);
assert.match(workerSource, /connector_layout_control/);
assert.match(workerSource, /layout_revision_conflict/);
assert.match(workerSource, /"layout_control"/);
assert.match(workerSource, /device_generation IS NULL OR device_generation < \?/);
assert.match(workerSource, /device_action_revision = revision \+ 1/);
assert.match(workerSource, /reported_revision IS NULL OR reported_revision < revision/);
assert.match(vueSource, /supportsLayoutAutoRecovery\(connector\)/);
assert.match(vueSource, /mergeConnectorLayoutControls/);

const staticAsset = await worker.fetch(new Request('https://message.example.com/assets/app.js', {
  headers: { authorization: `Bearer ${adminToken}` },
}), env, ctx);
assert.equal(staticAsset.status, 200);
assert.match(staticAsset.headers.get('cache-control'), /no-store/);
assert.equal(await staticAsset.text(), 'console.log("message-center-vue")');

const toolsList = await worker.fetch(new Request('https://message.example.com/mcp', {
  method: 'POST',
  headers: { authorization: `Bearer ${agentToken}`, 'content-type': 'application/json' },
  body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
}), env, ctx);
assert.equal(toolsList.status, 200);
const toolsBody = await toolsList.json();
const listener = toolsBody.result.tools.find((tool) => tool.name === 'listen_messages');
assert.ok(listener);
assert.deepEqual(listener.inputSchema.properties.triggers.items.enum, ['direct', 'mention', 'explicit_request']);
assert.ok(toolsBody.result.tools.some((tool) => tool.name === 'next_message'));
assert.ok(toolsBody.result.tools.some((tool) => tool.name === 'claim_message'));
assert.ok(toolsBody.result.tools.some((tool) => tool.name === 'consume_message'));

console.log('worker smoke tests passed');
