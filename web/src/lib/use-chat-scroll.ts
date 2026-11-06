"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { ConversationScrollPolicy } from "./chat-scroll";

export function useChatScroll(owner: string, revision: string, hasContent: boolean) {
  const scrollRef = useRef<HTMLDivElement>(null), contentRef = useRef<HTMLDivElement>(null);
  const policy = useRef(new ConversationScrollPolicy());
  const [away, setAway] = useState(false);
  const jumpToLatest = useCallback(() => {
    policy.current.requestLatest();
    const element = scrollRef.current;
    if (element) element.scrollTop = element.scrollHeight;
    setAway(false);
  }, []);
  useLayoutEffect(() => { policy.current = new ConversationScrollPolicy(); setAway(false); }, [owner]);
  useLayoutEffect(() => {
    if (policy.current.changed(hasContent)) jumpToLatest();
  }, [owner, revision, hasContent, jumpToLatest]);
  useEffect(() => {
    const content = contentRef.current, scroll = scrollRef.current;
    if (!content || !scroll) return;
    const observer = new ResizeObserver(() => {
      if (policy.current.following) scroll.scrollTop = scroll.scrollHeight;
      else setAway(!policy.current.observe(scroll));
    });
    observer.observe(content); observer.observe(scroll);
    return () => observer.disconnect();
  }, []);
  const onScroll = useCallback(() => {
    if (scrollRef.current) setAway(!policy.current.observe(scrollRef.current));
  }, []);
  return { scrollRef, contentRef, away, onScroll, jumpToLatest };
}
