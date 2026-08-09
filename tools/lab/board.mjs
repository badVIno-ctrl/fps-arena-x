/**
 * Open the gunsmith board in the live match and report what the preview did.
 * Optional: --weapon=<id> and --mount=<attachmentId> to reproduce the
 * "I mounted a module and the board shows nothing" report.
 */
export default async function board(page, api) {
  const weapon = process.env.LAB_WEAPON || 'm416';
  const mount = process.env.LAB_MOUNT || '';

  const opened = await page.evaluate((id) => {
    const e = window.__ENGINE__;
    const shell = e.ctx.peek('shell');
    if (!shell) return { error: 'no shell system' };
    shell.openGunsmith(id);
    return { open: shell.screen?.open ?? null, weaponId: shell.screen?.weaponId ?? null };
  }, weapon);
  api.log('opened', opened);

  await api.pump(30);

  if (mount) {
    const r = await page.evaluate((att) => {
      const s = window.__ENGINE__.ctx.peek('shell').screen;
      s.toggle(att);
      return { loadout: s.loadout(), issues: s.preview.issues() };
    }, mount);
    api.log('mounted', mount, r);
    await api.pump(20);
  }

  const probe = await page.evaluate(() => {
    const e = window.__ENGINE__;
    const shell = e.ctx.peek('shell');
    const s = shell.screen;
    const pv = s.preview;
    const cur = pv.current;
    let meshes = 0;
    let visibleMeshes = 0;
    let tris = 0;
    cur?.node.traverse((o) => {
      if (!o.isMesh) return;
      meshes++;
      let vis = o.visible;
      let p = o.parent;
      while (vis && p) {
        vis = p.visible;
        p = p.parent;
      }
      if (vis) {
        visibleMeshes++;
        tris += (o.geometry?.index?.count ?? o.geometry?.attributes?.position?.count ?? 0) / 3;
      }
    });
    const b = new (window.__ENGINE__.scene.constructor === Object ? Object : Object)();
    return {
      open: s.open,
      shown: Number(s.shown.toFixed(3)),
      rect: s._rect
        ? {
            l: Math.round(s._rect.left),
            t: Math.round(s._rect.top),
            w: Math.round(s._rect.width),
            h: Math.round(s._rect.height),
          }
        : null,
      currentId: cur?.id ?? null,
      meshes,
      visibleMeshes,
      tris: Math.round(tris),
      nodeVisible: cur?.node.visible ?? null,
      nodeScale: cur ? Number(cur.node.scale.x.toFixed(4)) : null,
      timeScale: e.time.scale,
      freezes: [...e.time._freezes],
      loadout: pv.loadout(),
      rigNodes: cur ? Object.keys(cur.rig?.mounted ?? cur.rig?._mounted ?? {}) : null,
    };
  });
  api.log('probe', JSON.stringify(probe, null, 2));

  await api.pump(6);
  await api.present(3);
  return probe;
}
