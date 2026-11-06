import { describe, expect, it } from "vitest";
import { Store } from "./store";

describe("record persistence scope", () => {
  it("rejects a cross-kind collision without returning fake persistence", () => {
    const store = new Store(":memory:");
    try {
      const user = store.ensureUser("0x1111111111111111111111111111111111111111");
      const record = { id: "same-id", userId: user.id, createdAt: 1, updatedAt: 1, value: "original" };
      store.put("first-kind", record);
      expect(() => store.put("another-kind", { ...record, value: "replacement" })).toThrow(expect.objectContaining({ code: "RECORD_ID_CONFLICT", status: 409 }));
      expect(store.get(user.id, "first-kind", record.id)).toEqual(record);
      expect(store.get(user.id, "another-kind", record.id)).toBeUndefined();
    } finally { store.db.close(); }
  });
  it("keeps another user's record intact on a guessed ID collision", () => {
    const store = new Store(":memory:");
    try {
      const user = store.ensureUser("0x1111111111111111111111111111111111111111"), other = store.ensureUser("0x2222222222222222222222222222222222222222");
      const record = { id: "same-id", userId: user.id, createdAt: 1, updatedAt: 1, value: "original" };
      store.put("kind", record);
      expect(() => store.put("kind", { ...record, userId: other.id })).toThrow(expect.objectContaining({ code: "RECORD_ID_CONFLICT", status: 409 }));
      expect(store.get(user.id, "kind", record.id)).toEqual(record);
      expect(store.list(other.id, "kind")).toEqual([]);
    } finally { store.db.close(); }
  });
  it("retains idempotent same-owner same-kind updates", () => {
    const store = new Store(":memory:");
    try {
      const user = store.ensureUser("0x1111111111111111111111111111111111111111");
      const record = { id: "same-id", userId: user.id, createdAt: 1, updatedAt: 1, value: "original" };
      expect(store.put("kind", record)).toEqual(record);
      expect(store.put("kind", record)).toEqual(record);
      const changed = { ...record, updatedAt: 2, value: "updated" };
      expect(store.put("kind", changed)).toEqual(changed);
      expect(store.list(user.id, "kind")).toEqual([changed]);
    } finally { store.db.close(); }
  });
});
