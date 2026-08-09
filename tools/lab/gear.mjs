/**
 * GEAR PROBE — the three dead keys, live.
 *
 * G, V and F have been declared in core/input.js since the first commit and read
 * by nothing. This drives each verb through the real subsystem in the real match
 * and reports what happened, because "the binding exists" and "the verb works"
 * are different claims.
 */
export default async function gear(page, api) {
  const present = await page.evaluate(() => {
    const e = window.__ENGINE__;
    const g = e.ctx.peek('gear');
    return g ? { state: { ...g.state }, interactables: [...g._interactables.keys()] } : null;
  });
  api.log('gear', JSON.stringify(present));

  // --- G: throw a frag -----------------------------------------------------
  const thrown = await page.evaluate(() => {
    const e = window.__ENGINE__;
    const g = e.ctx.peek('gear');
    let seen = null;
    const off = e.events.on('grenade:thrown', (ev) => (seen = { kind: ev.kind, fuse: ev.fuse }));
    const ok = g.throwLethal(0);
    off();
    return { ok, event: seen, live: g._live.length, left: g.state.lethal };
  });
  api.log('grenade', JSON.stringify(thrown));

  // Run the fuse out and confirm it detonates through the canonical event.
  const detonated = await page.evaluate(async () => {
    const e = window.__ENGINE__;
    let boom = null;
    const off = e.events.on('explosion', (ev) => (boom = { radius: ev.radius, damage: ev.damage }));
    // Burn the fuse down directly rather than stepping 240 frames: a full engine
    // step renders the world, and on a software rasteriser four seconds of
    // simulation is minutes of wall clock.
    for (const g of e.ctx.peek('gear')._live) g.fuse = 0.01;
    for (let i = 0; i < 3 && !boom; i++) e.step();
    off();
    return { boom, live: e.ctx.peek('gear')._live.length };
  });
  api.log('detonation', JSON.stringify(detonated));

  // --- V: melee ------------------------------------------------------------
  const melee = await page.evaluate(async () => {
    const e = window.__ENGINE__;
    const g = e.ctx.peek('gear');
    let swung = false;
    let hit = null;
    const offA = e.events.on('melee:swing', () => (swung = true));
    const offB = e.events.on('melee:hit', (ev) => (hit = { amount: ev.amount }));
    // Face a wall so the trace has something to find.
    g.melee();
    for (let i = 0; i < 6; i++) e.step();
    offA();
    offB();
    return { swung, hit, cooldown: g._cooldown > 0 };
  });
  api.log('melee', JSON.stringify(melee));

  // --- F: interaction ------------------------------------------------------
  const use = await page.evaluate(() => {
    const e = window.__ENGINE__;
    const g = e.ctx.peek('gear');
    const p = e.ctx.peek('player');
    const it = [...g._interactables.values()][0];
    const at = it.at();
    // Stand at the bench.
    p.teleport({ x: at.x + 0.8, y: at.y + 0.7, z: at.z + 0.8 }, 0);
    e.step();
    const near = g.nearest()?.id ?? null;
    const opened = g.useHeld();
    return { near, opened, boardOpen: e.ctx.peek('shell').screen.open };
  });
  api.log('use', JSON.stringify(use));

  // --- weapon condition ----------------------------------------------------
  const heat = await page.evaluate(() => {
    const e = window.__ENGINE__;
    e.ctx.peek('shell').closeGunsmith();
    const wp = e.ctx.peek('weapons');
    const c = wp.conditionFor();
    const before = { heat: c.heat, wear: c.wear, spread: wp.spreadDegrees };
    for (let i = 0; i < 60; i++) c.shoot(() => 1);
    const after = { heat: Number(c.heat.toFixed(3)), wear: Number(c.wear.toFixed(5)), spread: Number(wp.spreadDegrees.toFixed(3)) };
    const hud = wp.getHudState();
    return { before, after, hud: { heat: Number(hud.heat.toFixed(3)), wear: Number(hud.wear.toFixed(5)), jammed: hud.jammed } };
  });
  api.log('condition', JSON.stringify(heat));

  return { present, thrown, detonated, melee, use, heat };
}
