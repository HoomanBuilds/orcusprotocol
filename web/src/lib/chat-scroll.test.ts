import { describe, expect, it } from "vitest";
import { ConversationScrollPolicy, isNearConversationEnd, shouldSubmitMessage } from "./chat-scroll";

describe("conversation scroll intent", () => {
  it("submits Enter but preserves newlines and IME composition", () => {
    const event = { key: "Enter", shiftKey: false, isComposing: false };
    expect(shouldSubmitMessage(event)).toBe(true);
    expect(shouldSubmitMessage({ ...event, shiftKey: true })).toBe(false);
    expect(shouldSubmitMessage({ ...event, isComposing: true })).toBe(false);
    expect(shouldSubmitMessage({ ...event, keyCode: 229 })).toBe(false);
    expect(shouldSubmitMessage({ ...event, key: "a" })).toBe(false);
  });
  it("restores the bottom only after saved content arrives", () => {
    const policy = new ConversationScrollPolicy();
    expect(policy.changed(false)).toBe(false); expect(policy.restored).toBe(false);
    expect(policy.changed(true)).toBe(true); expect(policy.restored).toBe(true);
  });
  it("does not move a reader away from history when progress or answers arrive", () => {
    const policy = new ConversationScrollPolicy(); policy.changed(true);
    expect(policy.observe({ scrollTop: 100, scrollHeight: 2000, clientHeight: 600 })).toBe(false);
    expect(policy.changed(true)).toBe(false); expect(policy.changed(true)).toBe(false);
    policy.requestLatest(); expect(policy.changed(true)).toBe(true);
  });
  it("resumes following when the reader scrolls back to the bottom", () => {
    const policy = new ConversationScrollPolicy(); policy.changed(true);
    policy.observe({ scrollTop: 0, scrollHeight: 2000, clientHeight: 600 });
    expect(policy.observe({ scrollTop: 1400, scrollHeight: 2000, clientHeight: 600 })).toBe(true);
    expect(policy.changed(true)).toBe(true);
  });
  it("handles short threads, overscroll and the exact follow threshold", () => {
    expect(isNearConversationEnd({ scrollTop: 0, scrollHeight: 400, clientHeight: 600 })).toBe(true);
    expect(isNearConversationEnd({ scrollTop: 1600, scrollHeight: 2000, clientHeight: 600 })).toBe(true);
    expect(isNearConversationEnd({ scrollTop: 1320, scrollHeight: 2000, clientHeight: 600 })).toBe(true);
    expect(isNearConversationEnd({ scrollTop: 1319, scrollHeight: 2000, clientHeight: 600 })).toBe(false);
  });
});
