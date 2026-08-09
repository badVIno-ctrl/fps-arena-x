/**
 * Spawn-protection probe.
 *
 * Answers three questions the source cannot: does the shield exist at match
 * start, does incoming fire actually bounce off it, and do the bots hold their
 * fire while it is up.
 */
export default async function shieldProbe(page, api) {
  const start = await page.evaluate(() => {
    const p = window.__ENGINE__.ctx.peek('player');
    return { shield: p.health.shield, blind: p.health.shieldBlind, hp: p.health.value };
  });

  // Land a rifle round on the player while protected.
  const blocked = await page.evaluate(() => {
    const e = window.__ENGINE__;
    const p = e.ctx.peek('player');
    let seen = null;
    const off = e.events.on('damage:blocked', (ev) => (seen = ev));
    const dealt = p.health.damage(48, null, { part: 'torso', penetration: 1 });
    off();
    return { dealt, hp: p.health.value, event: seen ? { amount: seen.amount } : null };
  });

  const aiBlind = await page.evaluate(() => {
    const ai = window.__ENGINE__.ctx.peek('ai');
    return {
      playerUnseen: ai?.playerUnseen ?? null,
      agents: ai?.agents?.length ?? 0,
      withTarget: (ai?.agents ?? []).filter((a) => a.alive && a.hasTarget).length,
    };
  });

  // Firing must give it up immediately.
  const afterFire = await page.evaluate(() => {
    const e = window.__ENGINE__;
    e.events.emit('weapon:fire', { weapon: null });
    const p = e.ctx.peek('player');
    return { shield: p.health.shield, blind: p.health.shieldBlind };
  });

  const afterFireDamage = await page.evaluate(() => {
    const p = window.__ENGINE__.ctx.peek('player');
    const dealt = p.health.damage(20, null, { part: 'torso', penetration: 1 });
    return { dealt, hp: p.health.value };
  });

  return { start, blocked, aiBlind, afterFire, afterFireDamage };
}
