"use client";

import Link from "next/link";
import { ChevronDown, LogOut, Wallet } from "lucide-react";
import { useWorkspace } from "@/lib/use-workspace";
import { shortAddress } from "@/lib/format";
import { Spinner } from "../trading/primitives";
import styles from "./account-control.module.css";

export function AccountControl() {
  const w = useWorkspace();
  const disabled = w.connecting || w.executing || w.preparing || w.controlling;
  return <><div className={styles.desktop}>{w.demoMode ? <><span className="wallet-button" aria-label="Demo account, sample data only" title="Sample balances and positions. Public market prices are live."><span className="wallet-indicator"/>Demo account</span><button className="button secondary" type="button" aria-label="Exit demo account" onClick={() => w.changeDemoMode(false)}>Exit demo</button></> : <>
    <button className="button secondary" type="button" aria-label="Explore demo account" disabled={w.connecting || w.executing || w.preparing || w.controlling} onClick={() => w.changeDemoMode(true)}>Explore demo</button>
    {w.session.user ? <><Link href="/settings" className="wallet-button"><span className="wallet-indicator"/><span>{shortAddress(w.session.user.address)}</span><ChevronDown size={13}/></Link><button className="icon-button logout" type="button" aria-label="Sign out" title="Sign out" onClick={() => void w.disconnect()}><LogOut size={17}/></button></> : <button className="button primary connect-button" type="button" disabled={w.connecting} onClick={() => void w.connect()}>{w.connecting ? <Spinner/> : <Wallet size={16}/>}<span>{w.connecting ? "Sign in with wallet" : "Connect wallet"}</span></button>}
  </>}</div><details className={styles.mobile} onKeyDown={event => { if (event.key === "Escape") { event.currentTarget.open = false; event.currentTarget.querySelector("summary")?.focus(); } }}><summary className="wallet-button">{w.demoMode ? "Demo account" : w.session.user ? "Account" : "Connect"}<ChevronDown size={13}/></summary><div className={styles.menu}>
    {w.demoMode ? <><span>Sample data / read-only</span><button type="button" onClick={() => w.changeDemoMode(false)}>Exit demo</button></> : <><button type="button" disabled={disabled} onClick={() => w.changeDemoMode(true)}>Explore demo</button>{w.session.user ? <><Link href="/settings">{shortAddress(w.session.user.address)}</Link><button type="button" onClick={() => void w.disconnect()}>Sign out</button></> : <button type="button" disabled={disabled} onClick={() => void w.connect()}>Connect wallet</button>}</>}
  </div></details></>;
}
