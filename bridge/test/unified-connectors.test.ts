import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  assignLayoutControlOwner,
  parseConnectorInstances,
  parseConnectorTokens,
  uniqueConnectorInstances,
} from '../src/unified-connectors.js';

function deviceConnector(id: string, mode: 'device_relay' | 'cloud_relay' = 'device_relay') {
  return {
    id, kind: 'im', channelLabel: 'generic', accountLabel: id, displayName: id,
    note: '', mode, capabilities: ['receive_text'] as Array<'receive_text' | 'layout_control'>,
  };
}

test('parses multiple instances of one channel with independent capabilities', () => {
  const values = parseConnectorInstances(JSON.stringify({
    personal: {
      id: 'instance-email-personal', kind: 'email', accountLabel: 'personal@example.test',
      displayName: 'Personal mail', note: 'send and receive', mode: 'cloud_relay',
      capabilities: ['receive_text', 'send_text', 'receive_files', 'send_files'],
    },
    alerts: {
      id: 'instance-email-alerts', kind: 'email', accountLabel: 'alerts@example.test',
      displayName: 'Alerts', note: 'receive only', mode: 'cloud_relay',
      capabilities: ['receive_text'],
    },
  }), undefined);
  const personal = values.personal;
  const alerts = values.alerts;
  assert.ok(personal);
  assert.ok(alerts);
  assert.equal(personal.kind, 'email');
  assert.deepEqual(alerts.capabilities, ['receive_text']);
  assert.equal(uniqueConnectorInstances(values).length, 2);
});

test('requires every account profile to have an independent connector id', () => {
  const descriptor = {
    id: 'instance-device-shared', kind: 'im', accountLabel: 'team', displayName: 'Shared',
    note: '', mode: 'device_relay', capabilities: ['receive_text'],
  };
  assert.throws(
    () => parseConnectorInstances(JSON.stringify({ one: descriptor, two: descriptor }), undefined),
    /duplicate_connector_id/,
  );
});

test('declares layout control only on the explicit device relay owner', () => {
  const ownerId = 'instance-device-primary';
  const connectors = assignLayoutControlOwner([
    deviceConnector(ownerId),
    deviceConnector('instance-device-secondary'),
  ], ownerId);
  assert.deepEqual(connectors.find((item) => item.id === ownerId)?.capabilities,
    ['receive_text', 'layout_control']);
  assert.deepEqual(connectors.find((item) => item.id !== ownerId)?.capabilities, ['receive_text']);
});

test('rejects ambiguous or non-device layout control ownership', () => {
  const ownerId = 'instance-device-primary';
  assert.throws(
    () => assignLayoutControlOwner([deviceConnector(ownerId, 'cloud_relay')], ownerId),
    /layout_control_owner_requires_device_relay/,
  );
  assert.throws(
    () => assignLayoutControlOwner([{
      ...deviceConnector('instance-device-secondary'), capabilities: ['receive_text', 'layout_control'],
    }], undefined),
    /layout_control_owner_required/,
  );
});

test('keeps the legacy profile-to-id map compatible', () => {
  const values = parseConnectorInstances(undefined, JSON.stringify({ primary: 'connector-legacy-primary' }));
  const primary = values.primary;
  assert.ok(primary);
  assert.equal(primary.kind, 'im');
  assert.deepEqual(primary.capabilities, ['receive_text', 'send_text']);
});

test('binds each configured connector id to its own token', () => {
  const connectorA = 'instance-device-primary';
  const connectorB = 'instance-device-secondary';
  const tokenA = 'a'.repeat(40);
  const tokenB = 'b'.repeat(40);
  const values = parseConnectorTokens(
    JSON.stringify({ [connectorA]: tokenA, [connectorB]: tokenB }),
    'legacy-token-that-must-not-be-used'.repeat(2),
    [connectorA, connectorB],
  );
  assert.equal(values[connectorA], tokenA);
  assert.equal(values[connectorB], tokenB);
  assert.notEqual(values[connectorA], values[connectorB]);
});

test('does not fall back to the legacy token when a token map is configured', () => {
  const connectorA = 'instance-device-primary';
  const connectorB = 'instance-device-secondary';
  const legacy = 'l'.repeat(40);
  assert.throws(
    () => parseConnectorTokens(JSON.stringify({ [connectorA]: 'a'.repeat(40) }), legacy, [connectorA, connectorB]),
    /connector_token_missing:instance-device-secondary/,
  );
  assert.throws(
    () => parseConnectorTokens('{invalid-json', legacy, [connectorA]),
    /invalid_connector_tokens/,
  );
  assert.throws(
    () => parseConnectorTokens(
      JSON.stringify({ [connectorA]: 'x'.repeat(40), [connectorB]: 'x'.repeat(40) }),
      legacy,
      [connectorA, connectorB],
    ),
    /invalid_connector_tokens/,
  );
  assert.deepEqual(
    parseConnectorTokens(undefined, legacy, [connectorA, connectorB]),
    { [connectorA]: legacy, [connectorB]: legacy },
  );
});

test('unified relay authenticates every request with the selected connector id', () => {
  const source = readFileSync(new URL('../src/unified-relay.ts', import.meta.url), 'utf8');
  assert.match(source, /BRIDGE_MESSAGE_CONNECTOR_TOKENS/);
  assert.match(source, /headers: \{ \.\.\.connectorHeaders\(connectorId\), 'content-type': 'application\/json' \}/);
  assert.match(source, /post\(connector\.id, '\/api\/connectors\/register'/);
  assert.match(source, /headers: connectorHeaders\(connectorId\)/);
  assert.match(source, /health && health\[profileId\]\?\.state !== 'online'/);
  assert.match(source, /profile_connector_mapping_mismatch/);
  assert.match(source, /states\.length > 0 && states\.some/);
  assert.match(source, /device_\(\?:operation_not_dispatched\|conversation_not_found\)/);
  assert.ok(source.indexOf('assertCanSendConversationFile') < source.indexOf('adapter.sendReply'));
  assert.doesNotMatch(source, /const headers = \{ authorization:/);
});
