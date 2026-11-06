import { permanentRedirect } from "next/navigation";

export default function LegacyLandingPage() {
  permanentRedirect("/");
}
