/**
 * VIEWMODEL FRAMING.
 *
 * specs.js changed every weapon's overall length, so the question is whether the
 * hand rig and the ADS solve — which were tuned against the OLD figures — still
 * put the weapon somewhere sensible. A gun whose muzzle has left the frame or
 * whose stock is through the camera is a regression no gate can see.
 */
export default async function viewmodel(page, api) {
  const ids = (process.env.LAB_IDS || 'akm,m416,svd,mp5,glock18').split(',');
  const out = [];
  for (const id of ids) {
    const info = await page.evaluate((wid) => {
      const e = window.__ENGINE__;
      const wp = e.ctx.peek('weapons');
      wp.setWeaponImmediate(wid);
      wp.debugPose('idle');
      e.step();
      const vm = wp.viewmodel;
      const w = vm.weapons.get(wid);
      // The weapon group in CAMERA space: this is what the player sees.
      const g = w.group;
      g.updateMatrixWorld(true);
      const box = new (window.__BOX3__ ?? Object)();
      // Bounds via the viewmodel's own scratch, in the view camera's space.
      const THREE = vm.rig.constructor;
      return {
        id: wid,
        hip: g.position.toArray().map((v) => Number(v.toFixed(3))),
        muzzleLocal: w.muzzle.toArray().map((v) => Number(v.toFixed(3))),
        sightLocal: w.sight.toArray().map((v) => Number(v.toFixed(3))),
        magSeat: w.magSeatPos.toArray().map((v) => Number(v.toFixed(3))),
        tris: w.tris,
      };
    }, id);
    out.push(info);
    await api.pump(6);
    await api.present(2);
    await api.png(`shots/vm-${id}.png`);
  }
  console.error('\nid       hip(x,y,z)              muzzle(local)            sight(local)');
  for (const r of out) {
    console.error(
      r.id.padEnd(9) + JSON.stringify(r.hip).padEnd(24) + JSON.stringify(r.muzzleLocal).padEnd(25) + JSON.stringify(r.sightLocal),
    );
  }
  return out;
}
