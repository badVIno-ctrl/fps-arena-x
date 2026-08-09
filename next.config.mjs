/** @type {import('next').NextConfig} */

/**
 * The game ships as a fully static bundle served by the Python relay in
 * `server/main.py`, not by a Node server.
 *
 * Why: on Render's free tier one web service is one process. The relay has to
 * exist anyway (duel and squad modes need the WebSocket), so making it the
 * static host too collapses two services into one — and one free service is
 * exactly what the free tier gives you 750 instance-hours of. A second Node
 * service for `next start` would double the cold starts, double the wake-up
 * latency, and split the keep-alive problem in two.
 *
 * `output: 'export'` is honest about what this app is: a single client-rendered
 * route that boots WebGL. There is no server component, no route handler and no
 * ISR to give up — the export is not a downgrade, it is the correct shape.
 */
const nextConfig = {
  output: 'export',
  // `next build` writes here; server/main.py looks for this directory first.
  distDir: '.next',
  typescript: {
    ignoreBuildErrors: true,
  },
  images: {
    unoptimized: true,
  },
  // Static hosts serve `/foo/index.html` for `/foo` far more reliably than they
  // serve `/foo.html`, and StaticFiles(html=True) follows the same convention.
  trailingSlash: true,
  // Long-lived immutable asset names; the relay sets the matching cache headers.
  generateBuildId: async () => process.env.BUILD_ID ?? 'fps-arena-x',
}

export default nextConfig
