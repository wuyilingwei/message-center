export interface ConnectorSpoolItem {
  connectorId: string;
  name: string;
}

/**
 * Select an independent rotating window for every connector. Advancing the
 * cursor when a window is selected prevents one transient/poison item from
 * permanently hiding newer items, while preserving deterministic order inside
 * each selected window.
 */
export function selectFairSpoolWindows<T extends ConnectorSpoolItem>(
  items: T[],
  cursors: Map<string, string>,
  perConnectorLimit: number,
): Map<string, T[]> {
  if (!Number.isInteger(perConnectorLimit) || perConnectorLimit < 1) {
    throw new Error('invalid_spool_window_limit');
  }
  const grouped = new Map<string, T[]>();
  for (const item of items) {
    const group = grouped.get(item.connectorId) ?? [];
    group.push(item);
    grouped.set(item.connectorId, group);
  }
  const selected = new Map<string, T[]>();
  for (const [connectorId, values] of grouped) {
    const ordered = [...values].sort((left, right) => left.name.localeCompare(right.name));
    const cursor = cursors.get(connectorId);
    const afterCursor = cursor ? ordered.findIndex((item) => item.name > cursor) : 0;
    const start = afterCursor >= 0 ? afterCursor : 0;
    const window = [...ordered.slice(start), ...ordered.slice(0, start)].slice(0, perConnectorLimit);
    if (!window.length) continue;
    cursors.set(connectorId, window.at(-1)!.name);
    selected.set(connectorId, window);
  }
  return selected;
}
