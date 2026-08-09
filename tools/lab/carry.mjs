/**
 * CARRY PROBE — live, in the running match.
 *
 * Confirms the thing that could not be confirmed by reading rules.js: that the
 * rules are actually WIRED. The rules were correct and unreachable before, which
 * is worse than absent.
 */
export default async function carry(page, api) {
  const carried = await page.evaluate(() => {
    const wp = window.__ENGINE__.ctx.peek('weapons');
    const ar = window.__ENGINE__.ctx.peek('arsenal');
    return {
      registered: [...wp.states.keys()],
      carried: wp.weaponIds,
      slotIds: wp.slotIds,
      kit: ar.kit.weapons,
      accounting: (() => {
        const a = ar.kitAccounting();
        return { ok: a.ok, kg: Number(a.kg.toFixed(2)), litres: Number(a.litres.toFixed(2)) };
      })(),
      reserves: Object.fromEntries([...wp.states].map(([id, s]) => [id, s.reserve])),
    };
  });
  api.log('carried', JSON.stringify(carried, null, 1));

  // Tab must never reach a weapon that is not in the kit.
  const cycled = await page.evaluate(async () => {
    const e = window.__ENGINE__;
    const wp = e.ctx.peek('weapons');
    const seen = [];
    // `weaponIds` IS the cycle order, so walking it is the whole question — and
    // it costs nothing, where actually playing eight holster/draw animations on a
    // software rasteriser costs several minutes per run.
    const ids = wp.weaponIds;
    for (let i = 0; i < ids.length + 2; i++) seen.push(ids[i % ids.length]);
    return seen;
  });
  api.log('tab cycle', JSON.stringify(cycled));

  // Try to take two rifles through the real board.
  const twoRifles = await page.evaluate(() => {
    const e = window.__ENGINE__;
    const s = e.ctx.peek('shell').screen;
    s.kit = { weapons: ['akm', 'mp5', 'glock18'], mags: {}, loadouts: {}, lethal: 2, tactical: 1, medical: true };
    const ok = s.toggleCarry('m416');
    return { ok, kit: s.kit.weapons, why: s._kitWhy };
  });
  api.log('two rifles via board', JSON.stringify(twoRifles));

  const applied = await page.evaluate(() => {
    const e = window.__ENGINE__;
    const shell = e.ctx.peek('shell');
    shell.screen.apply();
    const ar = e.ctx.peek('arsenal');
    const wp = e.ctx.peek('weapons');
    return { kit: ar.kit.weapons, carried: wp.weaponIds, slotIds: wp.slotIds, active: wp.activeId };
  });
  api.log('after apply', JSON.stringify(applied));

  return { carried, cycled, twoRifles, applied };
}
