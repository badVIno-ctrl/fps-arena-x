/**
 * PART CENSUS.
 *
 * The contact sheet says "there is a bright ladder on top of the receiver". It
 * cannot say WHICH part that is, and guessing from pixels is how you spend an
 * hour moving the wrong box.
 *
 * This lists every mesh in the shown weapon with its material key and its
 * bounding box in WEAPON-LOCAL millimetres, sorted by how bright its material is,
 * so the thing stealing the frame is the first row.
 *
 * env LAB_WEAPON=akm
 */
export default async function census(page, api) {
  const id = process.env.LAB_WEAPON || 'akm';

  await page.evaluate((wid) => {
    const e = window.__ENGINE__;
    e.ctx.peek('shell').openGunsmith(wid);
    e.ctx.peek('shell').screen.selectWeapon(wid);
  }, id);
  await api.pump(6);

  const rows = await page.evaluate(() => {
    const pv = window.__ENGINE__.ctx.peek('shell').screen.preview;
    const cur = pv.current;
    const out = [];
    // The fit scale is applied to the node; divide it out so the numbers are the
    // weapon's own millimetres and can be compared with specs.js directly.
    const k = cur.node.scale.x || 1;
    const walk = (root, tag) => {
      root.traverse((o) => {
        if (!o.isMesh) return;
        o.geometry.computeBoundingBox();
        const b = o.geometry.boundingBox;
        const m = o.material;
        const c = m?.color;
        // Rec.709 luminance of the albedo — a decent proxy for "what will be
        // brightest on screen" for dielectrics under the same light.
        const lum = c ? 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b : 0;
        out.push({
          tag,
          name: o.name,
          mat: m?.name ?? '?',
          lum: Number(lum.toFixed(4)),
          rough: Number((m?.roughness ?? 0).toFixed(2)),
          metal: Number((m?.metalness ?? 0).toFixed(2)),
          x: [Math.round(b.min.x * 1000), Math.round(b.max.x * 1000)],
          y: [Math.round(b.min.y * 1000), Math.round(b.max.y * 1000)],
          z: [Math.round(b.min.z * 1000), Math.round(b.max.z * 1000)],
          tris: Math.round((o.geometry.index?.count ?? o.geometry.attributes.position.count) / 3),
        });
      });
    };
    walk(cur.node, 'weapon');
    out.sort((a, b) => b.lum - a.lum);
    return { scale: Number(k.toFixed(4)), rows: out };
  });

  console.error(`\n${id} — ${rows.rows.length} meshes, fit scale ${rows.scale}`);
  console.error('lum    rough metal tris   x(mm)         y(mm)         z(mm)          material / mesh');
  for (const r of rows.rows) {
    console.error(
      String(r.lum).padEnd(7) +
        String(r.rough).padEnd(6) +
        String(r.metal).padEnd(6) +
        String(r.tris).padEnd(7) +
        `${r.x[0]}..${r.x[1]}`.padEnd(14) +
        `${r.y[0]}..${r.y[1]}`.padEnd(14) +
        `${r.z[0]}..${r.z[1]}`.padEnd(15) +
        `${r.mat}  ${r.name}`,
    );
  }
  return { id, meshes: rows.rows.length };
}
