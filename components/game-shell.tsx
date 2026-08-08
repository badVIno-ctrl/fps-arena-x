'use client'

/**
 * The React side of the game is deliberately thin.
 *
 * Everything the player sees — menu, HUD, gunsmith board, results card — is
 * drawn by the engine straight into the DOM, because it has to update at frame
 * rate and React's reconciler has no business in that loop. So this component
 * owns exactly three things: the WebGL canvas, the `#ui` host the engine's UI
 * and shell systems look for by id, and the boot/teardown lifecycle.
 *
 * The lifecycle is the interesting part. `boot()` is async and sits waiting on
 * a menu click, which means a mount can be torn down mid-boot — React StrictMode
 * mounts twice in dev, and Fast Refresh remounts on every edit. Without care
 * that stacks engines, each holding a WebGL context, until the browser drops
 * the oldest and the game dies with a context-lost error. Hence the generation
 * counter: a boot whose generation is stale disposes itself the moment it
 * finishes instead of attaching to a canvas React has already thrown away.
 */

import { useEffect, useRef, useState } from 'react'

type BootHandle = { dispose: () => void }

export function GameShell() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const generation = useRef(0)
  const [failure, setFailure] = useState<string | null>(null)

  useEffect(() => {
    const mine = ++generation.current
    let handle: BootHandle | null = null

    void (async () => {
      try {
        const { boot } = await import('@/game/boot.js')
        const canvas = canvasRef.current
        // Torn down while the chunk was still downloading.
        if (!canvas || generation.current !== mine) return

        const booted = (await boot({ canvas })) as BootHandle

        // Torn down while the player sat in the menu. Dispose immediately —
        // this engine is attached to a canvas that is no longer on the page.
        if (generation.current !== mine) {
          booted.dispose()
          return
        }
        handle = booted
      } catch (err) {
        // A stale boot losing its canvas is expected, not an error worth
        // showing: the live mount is what the player is looking at.
        if (generation.current !== mine) return
        console.error('[game] boot failed', err)
        setFailure(err instanceof Error ? (err.stack ?? err.message) : String(err))
      }
    })()

    return () => {
      generation.current++
      handle?.dispose()
      handle = null
    }
  }, [])

  return (
    <main className="relative h-dvh w-screen overflow-hidden bg-black">
      <canvas
        id="game"
        ref={canvasRef}
        className="block h-full w-full touch-none [cursor:none]"
      />
      {/* The engine's UI and shell systems mount into this by id. */}
      <div id="ui" />

      {failure ? (
        <pre
          role="alert"
          className="fixed inset-0 z-[9999] overflow-auto whitespace-pre-wrap bg-black p-8 font-mono text-xs leading-relaxed text-red-400"
        >
          {`BOOT FAILURE\n\n${failure}`}
        </pre>
      ) : null}
    </main>
  )
}
