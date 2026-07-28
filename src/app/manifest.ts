import type { MetadataRoute } from 'next'

/**
 * Makes Wasify installable from the browser's "Add to Home Screen", so on a
 * phone it launches full-screen with no browser chrome — which is what the
 * three-pane inbox needs to feel like an app rather than a page.
 *
 * start_url is "/" on purpose: that route sends phones to the Inbox and
 * desktops to the Dashboard (see components/LandingRedirect.tsx).
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'Wasify — WhatsApp CRM',
    short_name: 'Wasify',
    description: 'WhatsApp inbox, COD confirmation and cart recovery for Shopify merchants.',
    start_url: '/',
    scope: '/',
    display: 'standalone',
    orientation: 'portrait-primary',
    background_color: '#0B1F16',
    theme_color: '#0B1F16',
    icons: [
      { src: '/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
      { src: '/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'maskable' },
    ],
  }
}
