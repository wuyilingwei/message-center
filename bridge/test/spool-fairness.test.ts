import assert from 'node:assert/strict';
import test from 'node:test';
import { selectFairSpoolWindows } from '../src/spool-fairness.js';

test('selects a quota independently for every connector', () => {
  const items = [
    ...Array.from({ length: 100 }, (_, index) => ({
      connectorId: 'connector-a', name: `a-${String(index).padStart(3, '0')}.json`,
    })),
    { connectorId: 'connector-z', name: 'z-only.json' },
  ];
  const selected = selectFairSpoolWindows(items, new Map(), 10);
  assert.equal(selected.get('connector-a')?.length, 10);
  assert.deepEqual(selected.get('connector-z'), [{ connectorId: 'connector-z', name: 'z-only.json' }]);
});

test('rotates past a transient first window instead of starving newer items', () => {
  const items = Array.from({ length: 12 }, (_, index) => ({
    connectorId: 'connector-a', name: `item-${String(index).padStart(2, '0')}.json`,
  }));
  const cursors = new Map<string, string>();
  assert.deepEqual(selectFairSpoolWindows(items, cursors, 5).get('connector-a')?.map((item) => item.name),
    ['item-00.json', 'item-01.json', 'item-02.json', 'item-03.json', 'item-04.json']);
  assert.deepEqual(selectFairSpoolWindows(items, cursors, 5).get('connector-a')?.map((item) => item.name),
    ['item-05.json', 'item-06.json', 'item-07.json', 'item-08.json', 'item-09.json']);
  assert.deepEqual(selectFairSpoolWindows(items, cursors, 5).get('connector-a')?.map((item) => item.name),
    ['item-10.json', 'item-11.json', 'item-00.json', 'item-01.json', 'item-02.json']);
});
