export class ServicePaymentScope {
  private current: { owner: string };
  private active = false;
  constructor(owner: string) { this.current = { owner: owner.toLowerCase() }; }
  changeOwner(owner: string) { if (this.current.owner !== owner.toLowerCase()) { this.current = { owner: owner.toLowerCase() }; this.active = false; } }
  activate() { this.current = { owner: this.current.owner }; this.active = true; }
  stop() { this.active = false; }
  capture() { return this.current; }
  isCurrent(request: { owner: string }) { return this.active && request === this.current; }
}
