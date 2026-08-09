/**
 * MOUNT PROBE — does the board show a module going on?
 *
 * Two claims to separate, because the report conflated them and they have
 * different causes: "the module is not APPLIED" and "the module is applied and
 * nothing on screen said so". This measures both — the mesh census before and
 * after, and the animation state mid-flight.
 */
export default async function mount(page, api) {
  const id = process.env.LAB_WEAPON || 'm416';
  const att = process.env.LAB_MOUNT || 'reddot';

  await page.evaluate((w) => {
    const e = window.__ENGINE__;
    e.ctx.peek('shell').openGunsmith(w);
    e.ctx.peek('shell').screen.selectWeapon(w);
  }, id);
  await api.pump(8);

  const count = () =>
    page.evaluate(() => {
      const pv = window.__ENGINE__.ctx.peek('shell').screen.preview;
      const cur = pv.current;
      let visible = 0;
      let tris = 0;
      cur.node.traverse((o) => {
        if (!o.isMesh) return;
        let vis = o.visible;
        let p = o.parent;
        while (vis && p) {
          vis = p.visible;
          p = p.parent;
        }
        if (!vis) return;
        visible++;
        tris += (o.geometry.index?.count ?? o.geometry.attributes.position.count) / 3;
      });
      return { visible, tris: Math.round(tris), loadout: pv.loadout(), animating: cur.rig.animating };
    });

  const before = await count();
  api.log('before', JSON.stringify(before));

  const clicked = await page.evaluate((a) => {
    const s = window.__ENGINE__.ctx.peek('shell').screen;
    s.toggle(a);
    const cur = s.preview.current;
    // Snapshot the animation the instant the click lands: if the part is already
    // seated here, there is no animation and the change is a hard cut.
    const anim = [...cur.rig._anim.entries()].map(([slot, x]) => ({
      slot,
      t: Number(x.t.toFixed(3)),
      target: x.target,
      pos: x.unit.object.position.toArray().map((v) => Number(v.toFixed(4))),
    }));
    return { loadout: s.preview.loadout(), anim };
  }, att);
  api.log('on click', JSON.stringify(clicked));

  await api.pump(3);
  const mid = await page.evaluate(() => {
    const cur = window.__ENGINE__.ctx.peek('shell').screen.preview.current;
    return [...cur.rig._anim.entries()].map(([slot, x]) => ({
      slot,
      t: Number(x.t.toFixed(3)),
      pos: x.unit.object.position.toArray().map((v) => Number(v.toFixed(4))),
    }));
  });
  api.log('mid-flight', JSON.stringify(mid));

  await api.pump(30);
  const after = await count();
  api.log('after', JSON.stringify(after));
  await api.present(2);
  await api.png(`shots/mount-${id}-${att}.png`);

  // And take it off again.
  const off = await page.evaluate((a) => {
    const s = window.__ENGINE__.ctx.peek('shell').screen;
    s.toggle(a);
    return { loadout: s.preview.loadout() };
  }, att);
  await api.pump(30);
  const removed = await count();
  api.log('after removal', JSON.stringify(off), JSON.stringify(removed));

  return { before, clicked, mid, after, removed };
}
