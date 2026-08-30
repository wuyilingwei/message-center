import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export type DeviceLayoutAction = "status" | "enable" | "disable" | "recover";

export interface DeviceLayoutCommand {
  reason?: string;
  serverRevision?: number;
  actionId?: string;
}

export interface LayoutControlDesired {
  enabled: boolean;
  revision: number;
  reason: string;
  updatedAt?: string | null;
  deviceGeneration?: number | null;
  deviceActionId?: string | null;
  deviceActionRevision?: number | null;
  deviceActionEnabled?: boolean | null;
}

export interface LayoutControlAcknowledgement {
  revision?: number;
  enabled: boolean;
  reason: string;
  deviceGeneration?: number;
  actionId?: string;
  localStop?: true;
  localStart?: true;
}

export interface LayoutControlCloudResult {
  ok: boolean;
  retry?: boolean;
  error?: string;
  layoutControl: LayoutControlDesired;
}

export interface LayoutControlCloud {
  read(): Promise<LayoutControlDesired>;
  acknowledge(value: LayoutControlAcknowledgement): Promise<LayoutControlCloudResult>;
}

export interface LayoutControlDevice {
  run(action: DeviceLayoutAction, command?: DeviceLayoutCommand): Promise<Record<string, unknown>>;
}

type LocalActionKind = "stop" | "start";

interface PendingLocalAction {
  kind: LocalActionKind;
  enabled: boolean;
  deviceGeneration: number;
  actionId: string;
  reason: "local_home_stop" | "local_icon_start";
}

interface LocalStopLock {
  deviceGeneration: number;
  actionId: string;
  revision: number;
}

export interface PersistedLayoutControlState {
  version: 1;
  lastSeenRevision: number;
  lastAppliedRevision: number;
  lastObservedDeviceGeneration: number;
  lastReportedDeviceGeneration: number;
  lastReportedActionId?: string;
  lastReportedRevision?: number;
  lastDeviceFingerprint?: string;
  deviceEnabled?: boolean;
  pendingLocalAction?: PendingLocalAction;
  localStopLock?: LocalStopLock;
}

export interface ConnectorLayoutControlSyncOptions {
  connectorId: string;
  statePath: string;
  cloud: LayoutControlCloud;
  device: LayoutControlDevice;
  administratorOverrideLocalLock: boolean;
}

interface DeviceStatus {
  enabled: boolean;
  deviceGeneration: number;
  actionId?: string;
  localActionKind?: LocalActionKind;
  source: string;
  reason: string;
  fingerprint: string;
}

const ACTION_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{7,199}$/;

function nonNegativeInteger(value: unknown, fallback = 0): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

function shortText(value: unknown, maximum = 160): string {
  return typeof value === "string" ? value.trim().slice(0, maximum) : "";
}

function desiredState(value: unknown): LayoutControlDesired {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("invalid_layout_control_state");
  }
  const input = value as Record<string, unknown>;
  if (typeof input.enabled !== "boolean") throw new Error("invalid_layout_control_enabled");
  const revision = nonNegativeInteger(input.revision, -1);
  if (revision < 0) throw new Error("invalid_layout_control_revision");
  const deviceGeneration = input.deviceGeneration === null
    ? null
    : nonNegativeInteger(input.deviceGeneration, -1);
  const deviceActionId = input.deviceActionId === null
    ? null
    : shortText(input.deviceActionId, 160);
  const deviceActionRevision = input.deviceActionRevision === null
    ? null
    : nonNegativeInteger(input.deviceActionRevision, -1);
  const deviceActionEnabled = input.deviceActionEnabled === null
    ? null
    : input.deviceActionEnabled;
  const hasDeviceAction = deviceGeneration !== null && deviceGeneration >= 0;
  if (hasDeviceAction !== Boolean(deviceActionId) ||
      hasDeviceAction !== (deviceActionRevision !== null && deviceActionRevision >= 0) ||
      hasDeviceAction !== (typeof deviceActionEnabled === "boolean")) {
    throw new Error("invalid_layout_control_device_action");
  }
  return {
    enabled: input.enabled,
    revision,
    reason: shortText(input.reason, 80) || "unknown",
    ...((input.updatedAt === null || typeof input.updatedAt === "string")
      ? { updatedAt: input.updatedAt as string | null }
      : {}),
    deviceGeneration: hasDeviceAction ? deviceGeneration : null,
    deviceActionId: hasDeviceAction ? deviceActionId : null,
    deviceActionRevision: hasDeviceAction ? deviceActionRevision : null,
    deviceActionEnabled: hasDeviceAction ? deviceActionEnabled as boolean : null,
  };
}

export function parseLayoutControlDesired(value: unknown): LayoutControlDesired {
  return desiredState(value);
}

function initialState(): PersistedLayoutControlState {
  return {
    version: 1,
    lastSeenRevision: 0,
    lastAppliedRevision: 0,
    lastObservedDeviceGeneration: 0,
    lastReportedDeviceGeneration: 0
  };
}

function parsePending(value: unknown): PendingLocalAction | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const item = value as Record<string, unknown>;
  const kind = item.kind === "stop" || item.kind === "start" ? item.kind : undefined;
  const deviceGeneration = nonNegativeInteger(item.deviceGeneration, -1);
  if (!kind || deviceGeneration < 1 || typeof item.actionId !== "string" ||
      !ACTION_ID_PATTERN.test(item.actionId)) return undefined;
  return {
    kind,
    enabled: kind === "start",
    deviceGeneration,
    actionId: item.actionId.slice(0, 160),
    reason: kind === "stop" ? "local_home_stop" : "local_icon_start"
  };
}

function parseStopLock(value: unknown): LocalStopLock | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const item = value as Record<string, unknown>;
  const deviceGeneration = nonNegativeInteger(item.deviceGeneration, -1);
  const revision = nonNegativeInteger(item.revision, -1);
  if (deviceGeneration < 1 || revision < 0 || typeof item.actionId !== "string" ||
      !ACTION_ID_PATTERN.test(item.actionId)) return undefined;
  return { deviceGeneration, revision, actionId: item.actionId.slice(0, 160) };
}

export function readLayoutControlState(path: string): PersistedLayoutControlState {
  if (!existsSync(path)) return initialState();
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new Error("layout_control_state_corrupt");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("layout_control_state_corrupt");
  }
  const item = parsed as Record<string, unknown>;
  if (item.version !== 1) throw new Error("layout_control_state_version_unsupported");
  const state: PersistedLayoutControlState = {
    version: 1,
    lastSeenRevision: nonNegativeInteger(item.lastSeenRevision),
    lastAppliedRevision: nonNegativeInteger(item.lastAppliedRevision),
    lastObservedDeviceGeneration: nonNegativeInteger(item.lastObservedDeviceGeneration),
    lastReportedDeviceGeneration: nonNegativeInteger(item.lastReportedDeviceGeneration),
    ...(typeof item.lastReportedActionId === "string"
      ? { lastReportedActionId: item.lastReportedActionId.slice(0, 160) }
      : {}),
    ...(Number.isSafeInteger(Number(item.lastReportedRevision)) && Number(item.lastReportedRevision) >= 0
      ? { lastReportedRevision: Number(item.lastReportedRevision) }
      : {}),
    ...(typeof item.lastDeviceFingerprint === "string"
      ? { lastDeviceFingerprint: item.lastDeviceFingerprint.slice(0, 500) }
      : {}),
    ...(typeof item.deviceEnabled === "boolean" ? { deviceEnabled: item.deviceEnabled } : {})
  };
  const pending = parsePending(item.pendingLocalAction);
  const lock = parseStopLock(item.localStopLock);
  if (pending) state.pendingLocalAction = pending;
  if (lock) state.localStopLock = lock;
  return state;
}

export function writeLayoutControlState(path: string, state: PersistedLayoutControlState): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(temporary, `${JSON.stringify(state)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
  renameSync(temporary, path);
}

export function connectorLayoutControlStatePath(runtimeDir: string, connectorId: string): string {
  const safe = connectorId.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 64);
  const digest = createHash("sha256").update(connectorId).digest("hex").slice(0, 16);
  return join(runtimeDir, "unified-relay", "layout-control", `${safe}-${digest}.json`);
}

function parseDeviceStatus(value: Record<string, unknown>): DeviceStatus {
  if (value.ok !== true) throw new Error(`layout_control_device_status_failed:${shortText(value.error) || "unknown"}`);
  const state = value.state && typeof value.state === "object" && !Array.isArray(value.state)
    ? value.state as Record<string, unknown>
    : value;
  const enabled = state.enabled === true;
  const deviceGeneration = nonNegativeInteger(state.lastLocalDeviceGeneration ?? state.deviceGeneration);
  const source = shortText(
    state.lastLocalActionSource ?? state.lastActionSource ?? state.actionSource,
    120,
  );
  const reason = shortText(
    state.lastLocalActionReason ?? state.runtimeReason ?? state.reason,
    160,
  );
  const actionIdCandidate = shortText(
    state.lastLocalActionId ?? state.actionId ?? state.lastActionId,
    200,
  );
  const nativeActionId = ACTION_ID_PATTERN.test(actionIdCandidate) ? actionIdCandidate : "";
  const localActionKind = state.lastLocalActionKind === "start" || state.lastLocalActionKind === "stop"
    ? state.lastLocalActionKind
    : undefined;
  const actionAt = shortText(state.lastLocalActionAt ?? state.lastActionAt, 80);
  return {
    enabled,
    deviceGeneration,
    ...(nativeActionId ? { actionId: nativeActionId } : {}),
    ...(localActionKind ? { localActionKind } : {}),
    source,
    reason,
    fingerprint: `${deviceGeneration}\u0000${enabled ? 1 : 0}\u0000${nativeActionId}\u0000${localActionKind || ""}\u0000${source}\u0000${reason}\u0000${actionAt}`
  };
}

function localActionKind(status: DeviceStatus): LocalActionKind | undefined {
  if (status.localActionKind) return status.localActionKind;
  const marker = `${status.source} ${status.reason}`.toLowerCase().replace(/[^a-z0-9]+/g, "_");
  if (!status.enabled && /(?:^|_)(?:local_)?home_(?:long_)?(?:press|stop)(?:_|$)/.test(marker)) return "stop";
  if (status.enabled && /(?:local_icon_start|launcher_icon|desktop_icon|notification_start|helper_launch|helper_switch|helper_configure)/.test(marker)) return "start";
  if (!status.enabled && /(?:helper_switch|helper_configure)/.test(marker)) return "stop";
  return undefined;
}

function derivedActionId(connectorId: string, generation: number, kind: LocalActionKind): string {
  return `layout-${createHash("sha256")
    .update(`${connectorId}\u0000${generation}\u0000${kind}`)
    .digest("hex")}`;
}

function assertDeviceResult(value: Record<string, unknown>, action: DeviceLayoutAction): void {
  if (value.ok !== true) {
    throw new Error(`layout_control_device_${action}_failed:${shortText(value.error) || "unknown"}`);
  }
}

function serverActionId(connectorId: string, revision: number, enabled: boolean): string {
  const digest = createHash("sha256")
    .update(`${connectorId}\u0000${revision}\u0000${enabled ? 1 : 0}`)
    .digest("hex");
  const version = `5${digest.slice(13, 16)}`;
  const variant = `${((Number.parseInt(digest[16] ?? "0", 16) & 0x3) | 0x8).toString(16)}${digest.slice(17, 20)}`;
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-${version}-${variant}-${digest.slice(20, 32)}`;
}

export class ConnectorLayoutControlSync {
  private state: PersistedLayoutControlState;

  constructor(private readonly options: ConnectorLayoutControlSyncOptions) {
    this.state = readLayoutControlState(options.statePath);
  }

  snapshot(): PersistedLayoutControlState {
    return structuredClone(this.state);
  }

  private save(): void {
    writeLayoutControlState(this.options.statePath, this.state);
  }

  private observe(status: DeviceStatus): void {
    this.state.deviceEnabled = status.enabled;
    if (this.state.pendingLocalAction) {
      this.save();
      return;
    }
    const newGeneration = status.deviceGeneration > this.state.lastObservedDeviceGeneration;
    const changedAtSameGeneration = status.deviceGeneration === this.state.lastObservedDeviceGeneration &&
      status.fingerprint !== this.state.lastDeviceFingerprint;
    if ((newGeneration || changedAtSameGeneration) && status.deviceGeneration > 0) {
      const kind = localActionKind(status);
      if (kind && status.deviceGeneration > this.state.lastReportedDeviceGeneration) {
        this.state.pendingLocalAction = {
          kind,
          enabled: kind === "start",
          deviceGeneration: status.deviceGeneration,
          actionId: status.actionId || derivedActionId(this.options.connectorId, status.deviceGeneration, kind),
          reason: kind === "stop" ? "local_home_stop" : "local_icon_start"
        };
      }
    }
    this.state.lastObservedDeviceGeneration = Math.max(
      this.state.lastObservedDeviceGeneration,
      status.deviceGeneration
    );
    this.state.lastDeviceFingerprint = status.fingerprint;
    this.save();
  }

  private acceptDeviceActionResult(
    current: LayoutControlDesired,
    expected?: PendingLocalAction,
  ): void {
    const generation = current.deviceGeneration;
    const actionId = current.deviceActionId;
    const actionRevision = current.deviceActionRevision;
    const actionEnabled = current.deviceActionEnabled;
    if (typeof generation !== "number" || !actionId ||
        typeof actionRevision !== "number" || typeof actionEnabled !== "boolean") {
      throw new Error("layout_control_device_action_result_missing");
    }
    if (expected && (generation !== expected.deviceGeneration || actionId !== expected.actionId ||
        actionEnabled !== expected.enabled)) {
      throw new Error("layout_control_device_action_result_mismatch");
    }
    this.state.lastReportedDeviceGeneration = Math.max(
      this.state.lastReportedDeviceGeneration,
      generation,
    );
    this.state.lastReportedActionId = actionId;
    this.state.lastReportedRevision = actionRevision;
    if (actionEnabled) {
      delete this.state.localStopLock;
    } else {
      this.state.localStopLock = {
        deviceGeneration: generation,
        actionId,
        revision: actionRevision,
      };
    }
  }

  private async flushPendingLocalAction(): Promise<LayoutControlDesired | undefined> {
    for (let attempt = 0; attempt < 4 && this.state.pendingLocalAction; attempt += 1) {
      const pending = this.state.pendingLocalAction;
      const result = await this.options.cloud.acknowledge({
        enabled: pending.enabled,
        reason: pending.reason,
        deviceGeneration: pending.deviceGeneration,
        actionId: pending.actionId,
        ...(pending.kind === "stop" ? { localStop: true } : { localStart: true })
      });
      const current = desiredState(result.layoutControl);
      this.state.lastSeenRevision = Math.max(this.state.lastSeenRevision, current.revision);
      if (!result.ok) {
        const serverGeneration = current.deviceGeneration;
        if (typeof serverGeneration === "number" && serverGeneration > pending.deviceGeneration) {
          this.acceptDeviceActionResult(current);
          delete this.state.pendingLocalAction;
          this.save();
          return current;
        }
        this.save();
        if (result.retry === true) continue;
        throw new Error(`layout_control_local_ack_failed:${result.error || "unknown"}`);
      }
      this.acceptDeviceActionResult(current, pending);
      delete this.state.pendingLocalAction;
      this.save();
      return current;
    }
    if (this.state.pendingLocalAction) throw new Error("layout_control_local_ack_retry_exhausted");
    return undefined;
  }

  private recordDeviceResult(enabled: boolean): void {
    this.state.deviceEnabled = enabled;
    this.save();
  }

  private desiredCanOverrideStopLock(desired: LayoutControlDesired): boolean {
    const lock = this.state.localStopLock;
    if (!lock || !desired.enabled) return true;
    return this.options.administratorOverrideLocalLock && desired.reason === "administrator" &&
      desired.revision > lock.revision;
  }

  private async applyDesired(
    desired: LayoutControlDesired,
  ): Promise<LayoutControlDesired | undefined> {
    if (desired.revision < this.state.lastSeenRevision) return undefined;
    this.state.lastSeenRevision = desired.revision;
    this.save();

    if (!this.desiredCanOverrideStopLock(desired)) return undefined;
    if (desired.enabled && this.state.localStopLock) {
      delete this.state.localStopLock;
      this.save();
    }

    if (this.state.lastAppliedRevision < desired.revision ||
        this.state.deviceEnabled !== desired.enabled) {
      const action = desired.enabled ? "enable" : "disable";
      const actionId = serverActionId(this.options.connectorId, desired.revision, desired.enabled);
      const result = await this.options.device.run(action, {
        reason: `cloud_apply_r${desired.revision}`,
        serverRevision: desired.revision,
        actionId,
      });
      assertDeviceResult(result, action);
      this.recordDeviceResult(desired.enabled);
    }

    const acknowledgement = await this.options.cloud.acknowledge({
      revision: desired.revision,
      enabled: desired.enabled,
      reason: "applied"
    });
    const current = desiredState(acknowledgement.layoutControl);
    this.state.lastSeenRevision = Math.max(this.state.lastSeenRevision, current.revision);
    if (!acknowledgement.ok) {
      this.save();
      if (acknowledgement.retry === true) return current;
      throw new Error(`layout_control_apply_ack_failed:${acknowledgement.error || "unknown"}`);
    }
    this.state.lastAppliedRevision = Math.max(this.state.lastAppliedRevision, desired.revision);
    this.state.deviceEnabled = desired.enabled;
    this.save();
    return undefined;
  }

  async synchronize(): Promise<void> {
    const firstRaw = await this.options.device.run("status");
    const firstStatus = parseDeviceStatus(firstRaw);
    this.observe(firstStatus);
    await this.flushPendingLocalAction();

    let desired = desiredState(await this.options.cloud.read());
    let applySettled = false;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const conflicted = await this.applyDesired(desired);
      if (!conflicted) {
        applySettled = true;
        break;
      }
      const retryRaw = await this.options.device.run("status");
      const retryStatus = parseDeviceStatus(retryRaw);
      this.observe(retryStatus);
      await this.flushPendingLocalAction();
      desired = desiredState(await this.options.cloud.read());
    }
    if (!applySettled) throw new Error("layout_control_apply_retry_exhausted");

    // A Home/icon action racing a cloud request is observed and reported before
    // this pass completes. Its generation/action id wins over the earlier
    // desired snapshot on the next server read.
    const finalRaw = await this.options.device.run("status");
    const finalStatus = parseDeviceStatus(finalRaw);
    this.observe(finalStatus);
    const localWinner = await this.flushPendingLocalAction();
    if (localWinner) {
      let winningDesired = desiredState(localWinner);
      for (let attempt = 0; attempt < 4; attempt += 1) {
        const conflicted = await this.applyDesired(winningDesired);
        if (!conflicted) return;
        winningDesired = desiredState(await this.options.cloud.read());
      }
      throw new Error("layout_control_final_local_apply_retry_exhausted");
    }
  }
}
