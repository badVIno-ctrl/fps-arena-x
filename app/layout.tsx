import type { Metadata, Viewport } from 'next'
import './globals.css'

/**
 * The HUD was designed against condensed faces ("DIN Condensed", "Avenir Next
 * Condensed"). Those exist on macOS and nowhere else, so naming them in CSS made
 * the whole interface silently collapse to plain sans-serif on Linux and Windows
 * and lose the tactical register it was drawn for. Real webfonts fix that.
 *
 * They are SELF-HOSTED, and that is a deliberate change from `next/font/google`.
 * next/font downloads the files from Google at build time, which means a deploy
 * can fail because a third party is unreachable from the build container — and it
 * fails hard, with no fallback. The faces now live in public/fonts with hand
 * written @font-face rules in app/fonts.css, where the unicode-range split
 * between latin and cyrillic is explicit (see that file; it is the part that is
 * easy to get wrong and impossible to notice).
 *
 * The two preloads below are the only files needed to paint the menu: the
 * cyrillic display weight for the masthead and the cyrillic body weight for
 * everything under it. Preloading all twenty would put 250 KB in front of the
 * first frame to save a swap on text nobody is reading yet.
 */

const PRELOAD = [
  '/fonts/oswald-cyrillic-700-normal.woff2',
  '/fonts/roboto-condensed-cyrillic-400-normal.woff2',
]

export const metadata: Metadata = {
  title: 'FPS ARENA — тактический шутер в браузере',
  description:
    'Браузерный тактический шутер от первого лица: зачистка и захват флага против ботов, дуэль 1×1, команды 10×10. Девять стволов, модульный обвес, один заброшенный город.',
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
    <html lang="ru" className="dark">
      <head>
        {PRELOAD.map((href) => (
          <link
            key={href}
            rel="preload"
            href={href}
            as="font"
            type="font/woff2"
            crossOrigin="anonymous"
          />
        ))}
      </head>
      <body className="bg-background antialiased">{children}</body>
    </html>
  )
}
