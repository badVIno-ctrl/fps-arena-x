import { Analytics } from '@vercel/analytics/next'
import type { Metadata, Viewport } from 'next'
import { Oswald, Roboto_Condensed, JetBrains_Mono } from 'next/font/google'
import './globals.css'

/**
 * The HUD was designed against condensed system faces ("Avenir Next Condensed",
 * "DIN Condensed"). Those exist on macOS and nowhere else, so on Linux and
 * Windows the whole interface silently collapsed to plain sans-serif and lost
 * the tactical register it was drawn for. Loading real condensed webfonts makes
 * the intended look reproducible on every machine — and keeps us off Inter.
 */
const display = Oswald({
  subsets: ['latin', 'cyrillic'],
  weight: ['400', '500', '600', '700'],
  variable: '--font-display',
  display: 'swap',
})

// Every string in this game is Russian, so a Cyrillic subset is not optional —
// a condensed face without one falls straight back to system sans and undoes the
// whole point. Roboto Condensed and Oswald both ship Cyrillic; Barlow Semi
// Condensed does not.
const body = Roboto_Condensed({
  subsets: ['latin', 'cyrillic'],
  weight: ['400', '500', '700'],
  variable: '--font-body',
  display: 'swap',
})

const mono = JetBrains_Mono({
  subsets: ['latin', 'cyrillic'],
  weight: ['400', '500', '700'],
  variable: '--font-mono',
  display: 'swap',
})

export const metadata: Metadata = {
  title: 'FPS ARENA — тактический шутер в браузере',
  description:
    'Браузерный тактический шутер от первого лица: зачистка и захват флага против ботов, дуэль 1×1, команды 10×10. Девять стволов, модульный обвес, один заброшенный город.',
  generator: 'v0.app',
  applicationName: 'FPS ARENA',
  icons: {
    icon: [{ url: '/crosshair.svg', type: 'image/svg+xml' }],
  },
}

export const viewport: Viewport = {
  colorScheme: 'dark',
  themeColor: '#0b0e13',
  width: 'device-width',
  initialScale: 1,
  // A shooter is a pointer-lock, fixed-viewport app: pinch-zoom mid-firefight
  // is never intentional.
  userScalable: false,
  viewportFit: 'cover',
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <html
      lang="ru"
      className={`dark ${display.variable} ${body.variable} ${mono.variable}`}
    >
      <body className="bg-background antialiased">
        {children}
        {process.env.NODE_ENV === 'production' && <Analytics />}
      </body>
    </html>
  )
}
