export function createLogoutQueue(logout: () => Promise<unknown>) {
  let pending = Promise.resolve();
  return {
    logout() { pending = pending.catch(() => undefined).then(async () => { await logout(); }); return pending; },
    wait() { return pending; },
  };
}
