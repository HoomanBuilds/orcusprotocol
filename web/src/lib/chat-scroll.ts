export type ScrollMetrics = { scrollTop: number; scrollHeight: number; clientHeight: number };

export function isNearConversationEnd(metrics: ScrollMetrics, threshold = 80) {
  return Math.max(0, metrics.scrollHeight - metrics.clientHeight - metrics.scrollTop) <= threshold;
}

export class ConversationScrollPolicy {
  following = true;
  restored = false;

  observe(metrics: ScrollMetrics) {
    this.following = isNearConversationEnd(metrics);
    return this.following;
  }

  changed(hasContent: boolean) {
    if (!hasContent) return false;
    if (!this.restored) {
      this.restored = true;
      this.following = true;
    }
    return this.following;
  }

  requestLatest() { this.following = true; }
}
export function shouldSubmitMessage(event: { key: string; shiftKey: boolean; isComposing: boolean; keyCode?: number }) {
  return event.key === "Enter" && !event.shiftKey && !event.isComposing && event.keyCode !== 229;
}

