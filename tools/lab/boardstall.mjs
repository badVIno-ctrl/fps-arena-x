/**
 * BOARD STALL PROBE.
 *
 * Measures what the player feels: how many WebGL programs compile on the frame
 * the gunsmith board opens, and whether the clock is running again after it
 * closes. A board that compiles shaders on open is a board that freezes the
 * game, and reading the source will not tell you whether it does.
 */
export default async function boardStall(page, api) {
  const warm = await page.evaluate(() => ({
    shellHook: window.__PREWARM__?.hooks?.shell ?? null,
    programs: window.__ENGINE__.ctx.peek('render').renderer.info.programs.length,
  }));
  api.log('warm', JSON.stringify(warm));

  const opened = await page.evaluate(() => {
    const e = window.__ENGINE__;
    const r = e.ctx.peek('render').renderer;
    window.__P0__ = r.info.programs.length;
    e.ctx.peek('shell').openGunsmith('m416');
    return { open: e.ctx.peek('shell').screen.open, freezes: [...e.time._freezes] };
  });
  api.log('opened', JSON.stringify(opened));

  await api.pump(4);
  const openCost = await page.evaluate(() => {
    const r = window.__ENGINE__.ctx.peek('render').renderer;
    return { compiledOnOpen: r.info.programs.length - window.__P0__ };
  });
  api.log('openCost', JSON.stringify(openCost));

  await api.pump(8);
  await api.present(2);
  await api.png('shots/board-open.png');

  const closed = await page.evaluate(() => {
    const e = window.__ENGINE__;
    const r = e.ctx.peek('render').renderer;
    window.__P1__ = r.info.programs.length;
    e.ctx.peek('shell').closeGunsmith();
    return { freezes: [...e.time._freezes], timeScale: e.time.scale };
  });
  api.log('closed', JSON.stringify(closed));

  await api.pump(10);
  const resumed = await page.evaluate(() => {
    const e = window.__ENGINE__;
    const r = e.ctx.peek('render').renderer;
    return {
      compiledOnClose: r.info.programs.length - window.__P1__,
      timeScale: e.time.scale,
      freezes: [...e.time._freezes],
      elapsed: Number(e.time.elapsed.toFixed(2)),
      controlEnabled: e.ctx.peek('player')?.controlEnabled ?? null,
      hudTarget: e.ctx.peek('ui')?.hudTarget ?? null,
    };
  });
  await api.present(2);
  await api.png('shots/board-closed.png');

  return { warm, openCost, closed, resumed };
}
