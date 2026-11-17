import type { Metadata } from "next";
import { Sora, Inter } from "next/font/google";
import "./globals.css";
import { Toaster } from "@/components/ui/toaster";

/* Self-hosted via next/font — zero layout shift, no external font links.
   Orbit Aurora pairing: Sora (geometric futuristic display) + Inter (body). */
const sora = Sora({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700", "800"],
  variable: "--font-sora",
  display: "swap",
});

const inter = Inter({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-inter",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Orbit Chat — Private Room Messenger",
  description:
    "A private lounge in the cloud. Share one room code and everyone who enters it lands in the same conversation — real-time messages, photos and replies, sealed with a key derived from the room code.",
  icons: {
    icon: "https://z-cdn.chatglm.cn/z-ai/static/logo.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body
        className={`antialiased bg-background text-foreground ${sora.variable} ${inter.variable}`}
      >
        {children}
        <Toaster />
      </body>
    </html>
  );
}
