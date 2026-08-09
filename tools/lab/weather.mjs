/**
 * WEATHER AND NVG PROBE.
 *
 * Renders the same street under each preset, and the same street at night with
 * the tube on and off. The point of the shots is the SIDE-BY-SIDE: a weather
 * effect that is invisible next to `clear` is not weather.
 *
 * It also reads back the two numbers that make it a mechanic rather than a
 * filter, because those cannot be seen in a screenshot at all.
 */
export default async function weather(page, api) {
  const presets = (process.env.LAB_WEATHER || 'clear,rain,fog').split(',');
  const out = [];

  await api.shot('hero');
  await api.pump(10);

  for (const name of presets) {
    const applied = await page.evaluate((n) => {
      const e = window.__ENGINE__;
      const w = e.ctx.peek('weather');
      const r = w.set(n, { fade: 0 });
      // `set` with fade 0 resolves immediately, but the apply happens in update().
      e.step();
      const ai = e.ctx.peek('ai');
      return {
        ok: r.ok,
        preset: w.preset,
        visibility: Math.round(w.visibility),
        soundMask: w.soundMask,
        wetness: Number(w.current.wetness.toFixed(2)),
        rain: Number(w.current.rain.toFixed(2)),
        aiViewScale: Number((ai?.viewRangeScale ?? 1).toFixed(3)),
        aiHearScale: Number((ai?.hearingScale ?? 1).toFixed(3)),
        agentSees: Number(((ai?.agents?.[0]?.viewRange ?? 0) * (ai?.viewRangeScale ?? 1)).toFixed(1)),
        fogDensity: Number((w.current.sky.fogDensity ?? 0).toFixed(2)),
      };
    }, name);
    out.push(applied);
    api.log(name, JSON.stringify(applied));
    await api.pump(24);
    await api.present(3);
    await api.png(`shots/weather-${name}.png`);
  }

  // --- night, with and without the tube -----------------------------------
  await page.evaluate(() => {
    const e = window.__ENGINE__;
    e.ctx.peek('weather').set('clear', { fade: 0 });
    e.ctx.peek('sky').setTimeOfDay(1.4);
  });
  await api.pump(30);
  await api.present(3);
  await api.png('shots/nvg-off.png');

  const nvg = await page.evaluate(() => {
    const e = window.__ENGINE__;
    const v = e.ctx.peek('vision');
    v.setEnabled(true);
    for (let i = 0; i < 45; i++) e.step();
    return { active: v.active, amount: Number(v.amount.toFixed(3)), battery: Number(v.battery.toFixed(4)), passEnabled: v.pass.enabled };
  });
  api.log('nvg', JSON.stringify(nvg));
  await api.pump(8);
  await api.present(3);
  await api.png('shots/nvg-on.png');

  return { presets: out, nvg };
}
