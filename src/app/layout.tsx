import type { Metadata, Viewport } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: 'Wasify — WhatsApp CRM for Shopify',
  description:
    'Turn WhatsApp into your sales channel: shared inbox, COD confirmation, cart recovery, broadcasts and flows for Shopify merchants.',
  icons: { icon: '/favicon.svg', apple: '/icon.svg' },
  manifest: '/manifest.webmanifest',
  appleWebApp: {
    capable: true,
    title: 'Wasify',
    // Matches the dark sidebar, so the iOS status bar blends into the shell.
    statusBarStyle: 'black-translucent',
  },
}

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  // Let the layout paint under the notch / home indicator; the .w-safe-*
  // helpers in globals.css add the insets back where they matter.
  viewportFit: 'cover',
  // Stops iOS zooming the whole page when a small input is focused.
  maximumScale: 1,
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#F7F9FB' },
    { media: '(prefers-color-scheme: dark)', color: '#0F172A' },
  ],
}

/** Applies the saved theme before first paint so dark mode never flashes white. */
const THEME_BOOTSTRAP = `
(function(){try{
  var s=localStorage.getItem('wasify-theme');
  var d=s?s==='dark':window.matchMedia('(prefers-color-scheme: dark)').matches;
  if(d)document.documentElement.setAttribute('data-dark','');
}catch(e){}})();
`

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="es" suppressHydrationWarning>
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
        <link
          href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Manrope:wght@600;700;800&family=JetBrains+Mono:wght@400;500&display=swap"
          rel="stylesheet"
        />
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOTSTRAP }} />
      </head>
      <body>{children}</body>
    </html>
  )
}
