import assert from "node:assert/strict";
import test from "node:test";
import { elementText, shouldReconcileCard } from "../src/adapters/device.js";

test("formats transfer cards without native identifiers", () => {
  const rendered = elementText({
    elementType: 49,
    kind: "card",
    card: {
      cardType: "transfer",
      title: "Transfer",
      amount: "¥12.34",
      summary: "Lunch",
      status: "Received"
    }
  });
  assert.equal(rendered, "[转账] ¥12.34 · Lunch · Received");
  assert.doesNotMatch(rendered, /transaction|username|<appmsg/i);
});

test("formats pat and generic application cards", () => {
  assert.equal(elementText({
    elementType: 49,
    kind: "card",
    card: { cardType: "pat", title: "拍一拍", summary: "A 拍了拍 B" }
  }), "[拍一拍] A 拍了拍 B");
  assert.equal(elementText({
    elementType: 49,
    kind: "card",
    card: { cardType: "app", title: "Article", summary: "Summary", source: "Publisher" }
  }), "[卡片] Article · Summary · Publisher");
});

test("replays recent cards once when the parser revision advances", () => {
  const now = 2_000_000_000;
  const record = {
    msgTime: now - 60,
    elements: [{ elementType: 49, kind: "card", card: { cardType: "transfer" as const } }]
  };
  assert.equal(shouldReconcileCard(record, 0, now), true);
  assert.equal(shouldReconcileCard(record, 1, now), false);
  assert.equal(shouldReconcileCard({ ...record, msgTime: now - 86_401 }, 0, now), false);
});
