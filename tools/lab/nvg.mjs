/**
 * Night, then night through the tube, then the tube looking at a bright source.
 * The third shot is the one that matters: an image intensifier that does not gate
 * on light is a green filter, and light being a counter to goggles is the whole
 * tactical content of the item.
 */
export default async function nvg(page, api) {
  await api.shot('night');
  await api.pump(24);
  await api.present(3);
  await api.png('shots/nvg-off.png');

  const on = await page.evaluate(() => {
    const e = window.__ENGINE__;
    const v = e.ctx.peek('vision');
    v.setEnabled(true);
    for (let i = 0; i < 50; i++) e.step();
    return {
      active: v.active,
      amount: Number(v.amount.toFixed(3)),
      battery: Number(v.battery.toFixed(4)),
      passEnabled: v.pass.enabled,
      gain: Number(v.pass.uniforms.uState.value.z.toFixed(1)),
    };
  });
  api.log('nvg on', JSON.stringify(on));
  await api.pump(6);
  await api.present(3);
  await api.png('shots/nvg-on.png');

  // Flat battery: the picture has to brown out before it goes.
  const flat = await page.evaluate(() => {
    const e = window.__ENGINE__;
    const v = e.ctx.peek('vision');
    v.battery = 0.05;
    for (let i = 0; i < 10; i++) e.step();
    return { gain: Number(v.pass.uniforms.uState.value.z.toFixed(1)), noise: Number(v.pass.uniforms.uState.value.w.toFixed(3)), warning: v.state.warning };
  });
  api.log('flat battery', JSON.stringify(flat));

  const dead = await page.evaluate(() => {
    const e = window.__ENGINE__;
    const v = e.ctx.peek('vision');
    v.battery = 0.0005;
    for (let i = 0; i < 6; i++) e.step();
    return { wanted: v.wanted, active: v.active, amount: Number(v.amount.toFixed(3)) };
  });
  api.log('dead battery', JSON.stringify(dead));

  return { on, flat, dead };
}
