import type { Metadata } from "next";
import { Cormorant, Montserrat } from "next/font/google";
import "./globals.css";
import { Toaster } from "@/components/ui/toaster";

/* Self-hosted via next/font — zero layout shift, no external font links
   (ui-ux-pro-max stack guideline: Luxury Serif pairing, Cormorant + Montserrat) */
const cormorant = Cormorant({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  style: ["normal", "italic"],
  variable: "--font-cormorant",
  display: "swap",
});

const montserrat = Montserrat({
  subsets: ["latin"],
  weight: ["300", "400", "500", "600", "700"],
  variable: "--font-montserrat",
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
        className={`antialiased bg-background text-foreground ${cormorant.variable} ${montserrat.variable}`}
      >
        {children}
        <Toaster />
      </body>
    </html>
  );
}
