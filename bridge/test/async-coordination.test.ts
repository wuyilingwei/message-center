import assert from "node:assert/strict";
import test from "node:test";
import { SerialExecutor, SingleFlightTask } from "../src/async-coordination.js";

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

test("single-flight reuses an active task and allows independent work", async () => {
  const profileGate = deferred();
  const profileFlight = new SingleFlightTask();
  const heartbeatFlight = new SingleFlightTask();
  let profileRuns = 0;
  let heartbeatRuns = 0;

  const first = profileFlight.run(async () => {
    profileRuns += 1;
    await profileGate.promise;
    return "profile";
  });
  const duplicate = profileFlight.run(async () => {
    profileRuns += 1;
    return "duplicate";
  });

  assert.strictEqual(duplicate, first);
  assert.equal(await heartbeatFlight.run(async () => {
    heartbeatRuns += 1;
    return "heartbeat";
  }), "heartbeat");
  assert.equal(profileRuns, 1);
  assert.equal(heartbeatRuns, 1);

  profileGate.resolve();
  assert.equal(await first, "profile");
  assert.equal(await profileFlight.run(async () => {
    profileRuns += 1;
    return "next";
  }), "next");
  assert.equal(profileRuns, 2);
});

test("single-flight clears after rejection", async () => {
  const flight = new SingleFlightTask();
  await assert.rejects(flight.run(async () => { throw new Error("failed"); }), /failed/);
  assert.equal(await flight.run(async () => 42), 42);
});

test("serial executor prevents overlapping device operations", async () => {
  const serial = new SerialExecutor();
  const firstGate = deferred();
  const order: string[] = [];

  const first = serial.run(async () => {
    order.push("first:start");
    await firstGate.promise;
    order.push("first:end");
  });
  const second = serial.run(async () => {
    order.push("second:start");
    order.push("second:end");
  });

  await Promise.resolve();
  assert.deepEqual(order, ["first:start"]);
  firstGate.resolve();
  await Promise.all([first, second]);
  assert.deepEqual(order, ["first:start", "first:end", "second:start", "second:end"]);
});

test("serial executor continues after a failed operation", async () => {
  const serial = new SerialExecutor();
  await assert.rejects(serial.run(async () => { throw new Error("failed"); }), /failed/);
  assert.equal(await serial.run(async () => "recovered"), "recovered");
});
