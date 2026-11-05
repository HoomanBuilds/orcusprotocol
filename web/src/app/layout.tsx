import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Orcus | Your trading copilot",
  description: "One trading workspace. Your decisions, your personal agent, your accounts. Powered by 0G, Uniswap and Chainlink CRE.",
  applicationName: "Orcus",
  icons: { icon: "/icon.svg" },
};

export const viewport: Viewport = { width: "device-width", initialScale: 1, themeColor: "#101210" };

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body>{children}</body></html>;
}
