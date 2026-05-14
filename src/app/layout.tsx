import type { Metadata } from "next";
import "./globals.css";
import { DemoBanner } from "@/components/demo-banner";
import { IS_DEMO } from "@/lib/demo";

export const metadata: Metadata = {
  title: "Churning Treasury",
  description: "Manufactured spend & credit card rewards treasury management",
  ...(IS_DEMO ? { robots: { index: false, follow: false } } : {}),
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className="dark">
      <body className="min-h-screen bg-background font-sans text-foreground antialiased">
        {IS_DEMO && <DemoBanner />}
        {children}
      </body>
    </html>
  );
}
