'use client'

import dynamic from 'next/dynamic'

/**
 * The game reads `window`, `navigator.hardwareConcurrency` and a WebGL context
 * during boot, so it cannot be server-rendered. `ssr: false` keeps it off the
 * server entirely rather than paying for a render that would throw.
 */
const GameShell = dynamic(
  () => import('@/components/game-shell').then((m) => m.GameShell),
  {
    ssr: false,
    loading: () => (
      <div className="grid h-dvh w-screen place-items-center bg-black">
        <p className="font-mono text-xs uppercase tracking-[0.3em] text-neutral-500">
          Загрузка
        </p>
      </div>
    ),
  },
)

export default function Page() {
  return <GameShell />
}
