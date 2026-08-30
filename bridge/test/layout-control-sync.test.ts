import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  ConnectorLayoutControlSync,
  readLayoutControlState,
  type DeviceLayoutAction,
  type DeviceLayoutCommand,
  type LayoutControlAcknowledgement,
  type LayoutControlCloud,
  type LayoutControlCloudResult,
  type LayoutControlDesired,
  type LayoutControlDevice,
} from "../src/layout-control-sync.js";

class FakeDevice implements LayoutControlDevice {
  enabled = false;
  generation = 0;
  source = "boot";
  reason = "disabled";
  actionId = "";
  localActionKind?: "start" | "stop";
  afterNextStatus?: () => void;
  readonly actions: Array<{ action: DeviceLayoutAction; command?: DeviceLayoutCommand }> = [];

  localStop(): void {
    this.enabled = false;
    this.generation += 1;
    this.source = "local_helper";
    this.reason = "home_long_press";
    this.actionId = `device-action-${this.generation}`;
    this.localActionKind = "stop";
  }

  localStart(): void {
    this.enabled = true;
    this.generation += 1;
    this.source = "launcher_icon";
    this.reason = "notification_start";
    this.actionId = `device-action-${this.generation}`;
    this.localActionKind = "start";
  }

  async run(action: DeviceLayoutAction, command?: DeviceLayoutCommand): Promise<Record<string, unknown>> {
    this.actions.push({ action, ...(command ? { command } : {}) });
    if (action === "status") {
      const result = {
        ok: true,
        action,
        state: {
          enabled: this.enabled,
          lastLocalDeviceGeneration: this.generation,
          lastLocalActionId: this.actionId,
          lastLocalActionKind: this.localActionKind,
          lastLocalActionSource: this.source,
          lastLocalActionReason: this.reason,
          lastLocalActionAt: this.generation,
        },
      };
      const afterStatus = this.afterNextStatus;
      delete this.afterNextStatus;
      afterStatus?.();
      return result;
    }
    this.enabled = action !== "disable";
    return {
      ok: true,
      action,
      enabled: this.enabled,
      serverRevision: command?.serverRevision,
      serverActionId: command?.actionId,
    };
  }
}

class FakeCloud implements LayoutControlCloud {
  desired: LayoutControlDesired;
  readonly acknowledgements: LayoutControlAcknowledgement[] = [];
  readonly localResults = new Map<string, {
    deviceGeneration: number;
    deviceActionId: string;
    deviceActionRevision: number;
    deviceActionEnabled: boolean;
  }>();
  beforeAcknowledge?: (value: LayoutControlAcknowledgement) => void;
  localRetryCount = 0;
  nextApplyConflict?: LayoutControlDesired;
  failNextApply = false;
  failNextLocalAfterCommit = false;

  constructor(desired: LayoutControlDesired) {
    this.desired = desired;
  }

  async read(): Promise<LayoutControlDesired> {
    return structuredClone(this.desired);
  }

  async acknowledge(value: LayoutControlAcknowledgement): Promise<LayoutControlCloudResult> {
    this.acknowledgements.push(structuredClone(value));
    this.beforeAcknowledge?.(value);
    if ((value.localStop || value.localStart) && this.localRetryCount > 0) {
      this.localRetryCount -= 1;
      return { ok: false, retry: true, error: "layout_generation_conflict", layoutControl: this.desired };
    }
    if (value.localStop || value.localStart) {
      assert.ok(value.actionId);
      assert.ok(value.deviceGeneration);
      const existing = this.localResults.get(value.actionId);
      if (existing) {
        return { ok: true, layoutControl: structuredClone({ ...this.desired, ...existing }) };
      }
      const actionResult = {
        deviceGeneration: value.deviceGeneration,
        deviceActionId: value.actionId,
        deviceActionRevision: this.desired.revision + 1,
        deviceActionEnabled: value.enabled,
      };
      this.desired = {
        enabled: value.enabled,
        revision: actionResult.deviceActionRevision,
        reason: value.localStop ? "device_local_stop" : "device_local_start",
        ...actionResult,
      };
      this.localResults.set(value.actionId, structuredClone(actionResult));
      if (this.failNextLocalAfterCommit) {
        this.failNextLocalAfterCommit = false;
        throw new Error("simulated_local_response_loss");
      }
    } else if (this.failNextApply) {
      this.failNextApply = false;
      throw new Error("simulated_network_loss");
    } else if (this.nextApplyConflict) {
      this.desired = this.nextApplyConflict;
      delete this.nextApplyConflict;
      return { ok: false, retry: true, error: "layout_revision_conflict", layoutControl: this.desired };
    }
    return { ok: true, layoutControl: structuredClone(this.desired) };
  }
}

function fixture(
  cloud: FakeCloud,
  device: FakeDevice,
  administratorOverrideLocalLock = true,
) {
  const root = mkdtempSync(join(tmpdir(), "layout-sync-"));
  const statePath = join(root, "state.json");
  return {
    statePath,
    sync: new ConnectorLayoutControlSync({
      connectorId: "instance-device-primary",
      statePath,
      cloud,
      device,
      administratorOverrideLocalLock,
    }),
  };
}

test("applies and acknowledges only the current desired revision", async () => {
  const cloud = new FakeCloud({ enabled: true, revision: 1, reason: "administrator" });
  const device = new FakeDevice();
  const { sync } = fixture(cloud, device);

  await sync.synchronize();

  assert.deepEqual(device.actions.map((item) => item.action), ["status", "enable", "status"]);
  assert.equal(device.actions[1]?.command?.serverRevision, 1);
  assert.match(device.actions[1]?.command?.actionId ?? "",
    /^[a-f0-9]{8}-[a-f0-9]{4}-5[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
  assert.deepEqual(cloud.acknowledgements, [{ revision: 1, enabled: true, reason: "applied" }]);
  assert.equal(sync.snapshot().lastAppliedRevision, 1);
  assert.equal(sync.snapshot().deviceEnabled, true);
});

test("advances every new server revision even when enabled already matches", async () => {
  const cloud = new FakeCloud({ enabled: true, revision: 1, reason: "administrator" });
  const device = new FakeDevice();
  device.enabled = true;
  const { sync } = fixture(cloud, device);
  await sync.synchronize();
  const firstId = device.actions.find((item) => item.action === "enable")?.command?.actionId;
  cloud.desired = { enabled: true, revision: 2, reason: "administrator" };
  device.actions.length = 0;

  await sync.synchronize();

  assert.deepEqual(device.actions.map((item) => item.action), ["status", "enable", "status"]);
  assert.notEqual(device.actions[1]?.command?.actionId, firstId);
  assert.equal(device.generation, 0);
  assert.equal(sync.snapshot().lastAppliedRevision, 2);
});

test("reasserts the desired state when device state differs at the same revision", async () => {
  const cloud = new FakeCloud({ enabled: false, revision: 0, reason: "not_configured" });
  const device = new FakeDevice();
  device.enabled = true;
  const { sync } = fixture(cloud, device);

  await sync.synchronize();

  assert.deepEqual(device.actions.map((item) => item.action), ["status", "disable", "status"]);
  assert.equal(device.enabled, false);
});

test("reuses the server action id after losing the acknowledgement response", async () => {
  const cloud = new FakeCloud({ enabled: true, revision: 1, reason: "administrator" });
  cloud.failNextApply = true;
  const device = new FakeDevice();
  const { sync } = fixture(cloud, device);

  await assert.rejects(sync.synchronize(), /simulated_network_loss/);
  const firstId = device.actions.find((item) => item.action === "enable")?.command?.actionId;
  device.actions.length = 0;
  await sync.synchronize();

  const retryId = device.actions.find((item) => item.action === "enable")?.command?.actionId;
  assert.equal(retryId, firstId);
  assert.equal(sync.snapshot().lastAppliedRevision, 1);
});

test("persists a Home stop before reporting it and rejects an older cloud snapshot", async () => {
  const cloud = new FakeCloud({ enabled: true, revision: 1, reason: "administrator" });
  const device = new FakeDevice();
  const { sync, statePath } = fixture(cloud, device);
  await sync.synchronize();
  device.actions.length = 0;
  cloud.acknowledgements.length = 0;
  device.localStop();
  cloud.beforeAcknowledge = (value) => {
    if (!value.localStop) return;
    const durable = readLayoutControlState(statePath);
    assert.equal(durable.pendingLocalAction?.deviceGeneration, value.deviceGeneration);
    assert.equal(durable.pendingLocalAction?.actionId, value.actionId);
  };

  await sync.synchronize();

  const stop = cloud.acknowledgements.find((value) => value.localStop);
  assert.ok(stop?.actionId);
  assert.equal(stop?.deviceGeneration, 1);
  assert.equal(stop?.revision, undefined);
  assert.equal(sync.snapshot().lastReportedDeviceGeneration, 1);
  assert.equal(sync.snapshot().localStopLock?.revision, 2);
  assert.equal(device.actions.some((item) => item.action === "enable"), false);

  cloud.desired = { enabled: true, revision: 1, reason: "administrator" };
  device.actions.length = 0;
  await sync.synchronize();
  assert.equal(device.actions.some((item) => item.action === "enable" || item.action === "recover"), false);
});

test("retries a local generation report with a stable action id", async () => {
  const cloud = new FakeCloud({ enabled: false, revision: 4, reason: "administrator" });
  cloud.localRetryCount = 1;
  const device = new FakeDevice();
  device.enabled = true;
  device.localStop();
  const { sync } = fixture(cloud, device);

  await sync.synchronize();

  const attempts = cloud.acknowledgements.filter((value) => value.localStop);
  assert.equal(attempts.length, 2);
  assert.equal(attempts[0]?.actionId, attempts[1]?.actionId);
  assert.equal(attempts[0]?.deviceGeneration, attempts[1]?.deviceGeneration);
  assert.equal(sync.snapshot().pendingLocalAction, undefined);
});

test("an idempotent local retry keeps its original action revision after a newer admin update", async () => {
  const cloud = new FakeCloud({ enabled: true, revision: 1, reason: "administrator" });
  const device = new FakeDevice();
  const { sync } = fixture(cloud, device);
  await sync.synchronize();

  device.localStop();
  cloud.failNextLocalAfterCommit = true;
  await assert.rejects(sync.synchronize(), /simulated_local_response_loss/);
  assert.equal(cloud.desired.revision, 2);
  assert.equal(cloud.desired.deviceActionRevision, 2);

  cloud.desired = {
    ...cloud.desired,
    enabled: true,
    revision: 3,
    reason: "administrator",
  };
  device.actions.length = 0;
  await sync.synchronize();

  assert.equal(sync.snapshot().lastReportedRevision, 2);
  assert.equal(sync.snapshot().localStopLock, undefined);
  assert.equal(sync.snapshot().lastAppliedRevision, 3);
  assert.equal(device.enabled, true);
  assert.equal(device.actions.some((item) => item.action === "enable"), true);
});

test("re-reads and applies the winning desired revision after an acknowledgement conflict", async () => {
  const cloud = new FakeCloud({ enabled: true, revision: 1, reason: "administrator" });
  cloud.nextApplyConflict = { enabled: false, revision: 2, reason: "administrator" };
  const device = new FakeDevice();
  const { sync } = fixture(cloud, device);

  await sync.synchronize();

  assert.equal(device.enabled, false);
  assert.equal(sync.snapshot().lastAppliedRevision, 2);
  assert.deepEqual(
    cloud.acknowledgements.filter((value) => !value.localStart && !value.localStop),
    [
      { revision: 1, enabled: true, reason: "applied" },
      { revision: 2, enabled: false, reason: "applied" },
    ],
  );
});

test("a newer explicit administrator revision can release the local stop lock", async () => {
  const cloud = new FakeCloud({ enabled: true, revision: 1, reason: "administrator" });
  const device = new FakeDevice();
  const { sync } = fixture(cloud, device);
  await sync.synchronize();
  device.localStop();
  await sync.synchronize();
  const stoppedRevision = cloud.desired.revision;

  cloud.desired = { enabled: true, revision: stoppedRevision + 1, reason: "administrator" };
  device.actions.length = 0;
  await sync.synchronize();

  assert.equal(sync.snapshot().localStopLock, undefined);
  assert.deepEqual(device.actions.map((item) => item.action), ["status", "enable", "status"]);
});

test("a local launcher start clears the Home stop lock before cloud apply", async () => {
  const cloud = new FakeCloud({ enabled: true, revision: 1, reason: "administrator" });
  const device = new FakeDevice();
  const { sync } = fixture(cloud, device, false);
  await sync.synchronize();
  device.localStop();
  await sync.synchronize();
  const stoppedGeneration = device.generation;
  device.localStart();
  cloud.acknowledgements.length = 0;

  await sync.synchronize();

  const start = cloud.acknowledgements.find((value) => value.localStart);
  assert.equal(start?.deviceGeneration, stoppedGeneration + 1);
  assert.ok(start?.actionId);
  assert.equal(sync.snapshot().localStopLock, undefined);
  assert.equal(cloud.desired.enabled, true);
});

test("a launcher start racing an older cloud disable is re-applied in the same pass", async () => {
  const cloud = new FakeCloud({ enabled: false, revision: 1, reason: "administrator" });
  const device = new FakeDevice();
  const { sync } = fixture(cloud, device);
  device.afterNextStatus = () => device.localStart();

  await sync.synchronize();

  assert.equal(cloud.desired.enabled, true);
  assert.equal(device.enabled, true);
  assert.deepEqual(device.actions.map((item) => item.action), [
    "status", "disable", "status", "enable",
  ]);
  assert.equal(sync.snapshot().lastAppliedRevision, 2);
});
