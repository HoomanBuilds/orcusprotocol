"use client";

import { useEffect, useRef, useState } from "react";
import { ArrowUpRight, Menu, Pause, Play, X } from "lucide-react";
import styles from "./landing.module.css";

export function LandingHeader({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const [scrolled, setScrolled] = useState(false);
  const [hidden, setHidden] = useState(false);
  const navigation = useRef<HTMLElement>(null);
  const toggle = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    let previousScroll = window.scrollY;
    const scroll = () => {
      const current = window.scrollY;
      setScrolled(current > 100);
      if (current < 100 || current < previousScroll - 4) setHidden(false);
      else if (current > previousScroll + 4 && current > 300) setHidden(true);
      previousScroll = current;
    };
    const close = (event: KeyboardEvent) => {
      if (event.key === "Escape" && toggle.current?.getAttribute("aria-expanded") === "true") { setOpen(false); toggle.current.focus(); }
    };
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !navigation.current?.contains(event.target)) setOpen(false);
    };
    scroll();
    window.addEventListener("scroll", scroll, { passive: true });
    document.addEventListener("keydown", close);
    document.addEventListener("pointerdown", outside);
    return () => { window.removeEventListener("scroll", scroll); document.removeEventListener("keydown", close); document.removeEventListener("pointerdown", outside); };
  }, []);

  return <header className={`${styles.header} ${scrolled ? styles.scrolledHeader : ""} ${hidden && !open ? styles.hiddenHeader : ""}`} ref={navigation}><a href="#top" aria-label="Orcus home" onClick={() => setOpen(false)}>{children}</a><div className={styles.headerRight}><a className={styles.navApp} href="/">Open app <ArrowUpRight size={15}/></a><button className={styles.menuToggle} type="button" aria-expanded={open} aria-controls="landing-navigation" aria-label={open ? "Close navigation" : "Open navigation"} onClick={() => setOpen(value => !value)} ref={toggle}>{open ? <X size={21}/> : <Menu size={21}/>}<span><strong>explore</strong><small>Orcus</small></span></button></div><nav className={styles.menu} id="landing-navigation" aria-label="Main navigation" hidden={!open}>{[["#about", "Meet Orcus"], ["#markets", "Trading venues"], ["#agent", "The agent"], ["#control", "Your control"], ["#scope", "Prototype scope"]].map(([href, text]) => <a key={href} href={href} onClick={() => setOpen(false)}>{text}<ArrowUpRight size={15}/></a>)}</nav></header>;
}

export function MotionVideo() {
  const video = useRef<HTMLVideoElement>(null);
  const userPaused = useRef(false);
  const [playing, setPlaying] = useState(false);
  const [allowed, setAllowed] = useState(false);

  useEffect(() => {
    const element = video.current;
    if (!element) return;
    const preference = window.matchMedia("(prefers-reduced-motion: reduce)");
    let visible = true;
    const sync = () => {
      setAllowed(!preference.matches);
      if (!preference.matches && visible && !userPaused.current) void element.play().catch(() => setPlaying(false));
      else element.pause();
    };
    const observer = new IntersectionObserver(([entry]) => { visible = entry.isIntersecting; sync(); });
    observer.observe(element);
    preference.addEventListener("change", sync);
    sync();
    return () => { observer.disconnect(); preference.removeEventListener("change", sync); element.pause(); };
  }, []);

  return <><video className={styles.heroVideo} ref={video} muted playsInline preload="none" poster="/landing/hero-poster.webp" aria-hidden="true" onLoadedMetadata={() => { if (video.current && video.current.duration > 6) video.current.currentTime = 6; }} onEnded={() => { if (video.current && allowed && !userPaused.current) { video.current.currentTime = 6; void video.current.play().catch(() => setPlaying(false)); } }} onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)}><source media="(max-width: 767px)" src="/landing/hero-mobile.webm" type="video/webm"/><source src="/landing/hero.webm" type="video/webm"/></video>{allowed && <button className={styles.videoControl} aria-label={playing ? "Pause background video" : "Play background video"} type="button" onClick={() => { userPaused.current = playing; if (playing) video.current?.pause(); else void video.current?.play().catch(() => setPlaying(false)); }}>{playing ? <Pause size={14}/> : <Play size={14}/>}</button>}</>;
}

export function MarketMotion({ children }: { children: React.ReactNode }) {
  const [paused, setPaused] = useState(false);
  return <><div className={`${styles.marketRows} ${paused ? styles.pausedMarkets : ""}`}>{children}</div><button className={styles.marketMotionControl} type="button" aria-pressed={paused} onClick={() => setPaused(value => !value)}>{paused ? <Play size={12}/> : <Pause size={12}/>} {paused ? "Resume" : "Pause"} cards</button></>;
}
