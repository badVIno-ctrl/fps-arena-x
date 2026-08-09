/**
 * WEAPON CONTACT SHEET — the critic's instrument.
 *
 * Renders every weapon in the arsenal from the same orthogonal-ish side view,
 * on the same neutral studio light, at the same scale, and writes one PNG per
 * weapon plus a printed table of measured dimensions.
 *
 * Side profile is not an aesthetic choice: a firearm is IDENTIFIED by its
 * silhouette, so this is the view in which "the AK and the M416 look the same"
 * is either true or false, and no amount of three-quarter hero framing can
 * settle it.
 *
 * env LAB_IDS=akm,m416   restrict the sheet
 * env LAB_YAW=-1.5708    override the turntable yaw (default: left profile)
 * env LAB_TAG=after      filename suffix
 */

const DEFAULT_IDS = ['akm', 'ak74', 'm416', 'scar', 'svd', 'mp5', 'm870', 'glock18', 'deagle'];

export default async function sheet(page, api) {
  const ids = (process.env.LAB_IDS || DEFAULT_IDS.join(',')).split(',').filter(Boolean);
  const tag = process.env.LAB_TAG || 'now';
  const yaw = Number(process.env.LAB_YAW ?? -Math.PI / 2);

  await page.evaluate(() => {
    const e = window.__ENGINE__;
    e.ctx.peek('shell').openGunsmith('m416');
  });
  await api.pump(10);

  // Studio: kill the turntable, flatten the view, raise the key so the
  // silhouette and every chamfer are legible instead of nearly black.
  await page.evaluate((y) => {
    const pv = window.__ENGINE__.ctx.peek('shell').screen.preview;
    pv.__labStudio = true;
    pv.yaw = pv.targetYaw = y;
    pv.pitch = pv.targetPitch = 0;
    pv.dragging = true; // stops the idle spin in update()
    pv.key.intensity = 4.6;
    pv.fill.intensity = 2.0;
    pv.rim.intensity = 2.4;
    const front = new pv.key.constructor(0xffffff, 1.4);
    front.position.set(0, 0.1, 1);
    front.castShadow = false;
    pv.scene.add(front);
  }, yaw);

  const rows = [];
  for (const id of ids) {
    const info = await page.evaluate((wid) => {
      const s = window.__ENGINE__.ctx.peek('shell').screen;
      s.selectWeapon(wid);
      const pv = s.preview;
      pv.yaw = pv.targetYaw;
      pv.pitch = pv.targetPitch;
      pv.spin.rotation.set(pv.pitch, pv.yaw, 0);
      const cur = pv.current;
      cur.node.updateMatrixWorld(true);
      const THREE = window.__THREE__;
      // Unscaled extents: measure the model in metres, not in panel units.
      const prevScale = cur.node.scale.x;
      const box = new pv._box.constructor().setFromObject(cur.node);
      const size = box.getSize(new pv._size.constructor());
      return {
        id: wid,
        scale: Number(prevScale.toFixed(4)),
        // divide out the fit scale to recover metres
        lengthM: Number((size.z / prevScale).toFixed(3)),
        heightM: Number((size.y / prevScale).toFixed(3)),
        widthM: Number((size.x / prevScale).toFixed(3)),
      };
    }, id);
    rows.push(info);
    await api.pump(6);
    await api.present(3);
    await api.png(`shots/sheet-${tag}-${id}.png`);
  }

  console.error(
    '\nid        len(m) height(m) width(m)\n' +
      rows
        .map(
          (r) =>
            r.id.padEnd(10) +
            String(r.lengthM).padEnd(7) +
            String(r.heightM).padEnd(10) +
            String(r.widthM),
        )
        .join('\n'),
  );
  return rows;
}
