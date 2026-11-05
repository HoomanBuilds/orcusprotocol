import Link from "next/link";

export default function NotFound() {
  return <main className="not-found"><span className="eyebrow">404 / NOT FOUND</span><h1>Outside the market.</h1><p>This page does not exist. Your trading workspace is one click away.</p><Link className="button primary" href="/">Back to terminal</Link></main>;
}
