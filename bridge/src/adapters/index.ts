import type { AppConfig } from "../config.js";
import type { BridgeAdapter } from "../types.js";
import { DeviceSessionAdapter } from "./device.js";
import { SpoolBridgeAdapter } from "./spool.js";

export function createAdapter(config: AppConfig): BridgeAdapter {
  return config.adapter === "device" ? new DeviceSessionAdapter(config) : new SpoolBridgeAdapter(config);
}
