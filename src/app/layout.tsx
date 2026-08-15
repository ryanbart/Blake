import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Blake — Conversation Intelligence",
  description:
    "Call and meeting coaching, issue flagging, and CRM autofill for Dialpad and Fellow.",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body className="min-h-screen antialiased">{children}</body>
    </html>
  );
}
