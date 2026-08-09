export default async function nvgQuick(page, api) {
  await page.evaluate(() => window.__ENGINE__.ctx.peek('sky').setTimeOfDay(1.4));
  await api.pump(16);
  await api.present(2);
  await api.png('shots/nvg-off.png');

  const on = await page.evaluate(() => {
    const v = window.__ENGINE__.ctx.peek('vision');
    v.setEnabled(true);
    v.amount = 1;               // skip the warm-up: this is a still, not a demo
    v.pass.sync(1, 3.2);
    return { active: v.active, passEnabled: v.pass.enabled, gain: v.pass.uniforms.uState.value.z };
  });
  api.log('nvg', JSON.stringify(on));
  await api.pump(10);
  await api.present(2);
  await api.png('shots/nvg-on.png');
  return on;
}
