import { describe, expect, it, vi } from "vitest";
import { createLogoutQueue } from "./session-state";

describe("wallet session transitions", () => {
  it("holds a new login behind every outstanding logout so a late logout cannot delete its cookie", async () => {
    let finish!: () => void;
    const first = new Promise<void>(resolve => { finish = resolve; });
    const logout = vi.fn().mockReturnValueOnce(first).mockResolvedValueOnce(undefined), queue = createLogoutQueue(logout);
    const one = queue.logout(), two = queue.logout();
    const verify = vi.fn();
    const login = queue.wait().then(verify);
    await vi.waitFor(() => expect(logout).toHaveBeenCalledTimes(1)); expect(verify).not.toHaveBeenCalled();
    finish(); await Promise.all([one, two, login]);
    expect(logout).toHaveBeenCalledTimes(2); expect(verify).toHaveBeenCalledOnce();
  });
  it("does not verify a new login after a failed pending logout until a later logout succeeds", async () => {
    const logout = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce(undefined), queue = createLogoutQueue(logout);
    await expect(queue.logout()).rejects.toThrow("offline");
    await expect(queue.wait()).rejects.toThrow("offline");
    await queue.logout(); await expect(queue.wait()).resolves.toBeUndefined();
  });
});
