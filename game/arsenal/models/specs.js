/**
 * ARSENAL — model specifications.
 *
 * The base engine builds its M4A1 in src/weapons/models/rifle.js: about fifteen
 * calls into the parts kit, each one fed hand-solved millimetre figures. That
 * file is the quality bar for this project, and copying it nine times would
 * mean nine places to get the same detail wrong.
 *
 * So the geometry is split in two:
 *
 *   specs.js  (this file)  pure numbers and pure functions. No three.js, no
 *                          Assembly, nothing that needs a GPU — which means the
 *                          entire layout of all nine weapons is unit-testable
 *                          in node, including every attachment node position.
 *   build.js               turns one spec into real geometry by mirroring the
 *                          rifle.js call sequence against the parts kit.
 *
 * COORDINATES, copied from the base engine so everything lines up:
 *   -Z points down range (the muzzle is at negative z)
 *   +Y is up; `bore` is the height of the barrel axis above the grip web
 *   +X is right
 * All figures are METRES. A 5 mm mistake is visible in ADS.
 *
 * The `pattern` field selects the receiver architecture in build.js. Five real
 * architectures cover the roster, which is why an AK does not end up looking
 * like an AR with different numbers:
 *   'ar'     split upper/lower, receiver extension stock, AR magwell
 *   'ak'     riveted receiver, dust cover, gas tube over the barrel, side rail
 *   'battle' SCAR-pattern monolithic upper with a folding side stock
 *   'dmr'    long-barrelled SVD: wood furniture, thumbhole stock, side mount
 *   'smg'    MP5-pattern tubular receiver with a wrap-around handguard
 *   'pump'   tube-fed shotgun with a sliding forend and no detachable magazine
 *   'pistol' slide + polymer or steel frame, no stock, mini reflex mount
 */

/** Every node the weapons system expects a model to publish. */
export const REQUIRED_NODES = [
  'muzzle',
  'chamber',
  'eject',
  'ejectDir',
  'sight',
  'sightAxis',
  'ironSight',
  'gripR',
  'gripL',
  'handguard',
  'magSeat',
  'magDrop',
  'chargeRest',
  'chargePull',
  'boltRest',
  'boltTravel',
  'triggerPivot',
  'triggerPull',
  'selectorPivot',
  'opticGlass',
];

/** Moving parts every model animates. Pumps and pistols swap some of these. */
export const MOVING_PARTS = ['magazine', 'charging', 'bolt', 'trigger', 'selector'];
/**
 * The nine specs — REBUILT FROM REAL DIMENSIONS.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS TABLE WAS REWRITTEN
 * ---------------------------------------------------------------------------
 * The previous numbers were "anchored to the base M4A1 and offset by feel", and
 * the result was measurable: rendered in profile on one light, the АКМ and the
 * M416 had the same silhouette. Both had a 186-245 mm receiver carrying a
 * 212-226 mm magazine, which is a proportion no service rifle has ever had — an
 * AK receiver is 275 mm and its magazine is 175 mm, so the model had the ratio
 * almost exactly INVERTED. Everything downstream of that inherits the error: the
 * gun reads as a short box with an enormous banana hanging off it, and once two
 * rifles share that shape no amount of rivet detail tells them apart.
 *
 * So every figure below is now a real published dimension, written in
 * MILLIMETRES in the literal so it can be checked against a spec sheet, and
 * converted once by `mm()`.
 *
 * ---------------------------------------------------------------------------
 * THE ORIGIN, AND WHY IT MATTERS
 * ---------------------------------------------------------------------------
 * z = 0 is the GRIP WEB — the web of the firing hand, between thumb and
 * forefinger. Not the receiver, not the muzzle. That choice is what makes the
 * table verifiable, because two real, published figures are measured from very
 * near it:
 *
 *   length of pull   trigger to buttplate. Puts `stockRear`.
 *   overall length   buttplate to muzzle.  Then puts `muzzleZ`, hence the barrel.
 *
 * An AKM is 880 mm overall with a 340 mm length of pull, so its buttplate is at
 * +340 and its muzzle at 340 − 880 = −540. Every other z on the weapon is then
 * pinned between those two by the parts that physically occupy the space:
 * receiver 275 mm, barrel protruding ~315 mm ahead of the front trunnion.
 * 275 + 315 + 290 ≈ 880. The table closes.
 *
 * ---------------------------------------------------------------------------
 * VIEWMODEL COMPRESSION
 * ---------------------------------------------------------------------------
 * `K` scales every z and every radius. It is NOT a fudge factor for making the
 * numbers agree — the numbers agree at K = 1. It exists because a first-person
 * weapon is held about 300 mm from the eye, where a full-size rifle would put
 * its buttplate well behind the near plane and its muzzle most of the way across
 * the frame. Games have always compressed this; the honest version is to write
 * reality down and compress it in ONE place, visibly, rather than to distribute
 * the compression as a hundred hand-tweaked millimetres nobody can audit.
 *
 * 0.88 was chosen so overall lengths land within a few percent of the poses the
 * hand rig and the ADS solve were already tuned against (the АКМ goes 750 → 774
 * mm), which means the proportions could be fixed WITHOUT re-solving the hand
 * IK, the eye relief and the sight axis at the same time. Changing one thing at
 * a time is the only way this stays reviewable.
 *
 * Bore height is exempt. It is the archetype's eye-line constant (see
 * CLASS_ARCHETYPES in arsenal/defs.js) and the gate pins the two together.
 *
 * ---------------------------------------------------------------------------
 * COORDINATES  (unchanged)
 * ---------------------------------------------------------------------------
 *   −Z down range, +Y up, +X right. Metres after `mm()`.
 *
 * `pattern` selects the receiver architecture; `signature` selects the family's
 * unmistakable geometry in models/signature.js. Those are different questions:
 * an АКМ and an АК-74 share the `ak` architecture and differ in signature
 * (wood vs polymer furniture, slant brake vs four-port brake).
 */

/**
 * Viewmodel compression. See the note above — real dimensions go in the table,
 * this is the single place they are scaled.
 */
export const K = 0.88;

/** Millimetres of real weapon → metres of viewmodel. */
const mm = (v) => (v * K) / 1000;

/** Millimetres of real weapon → metres, for a whole record of them. */
const mmAll = (o) => {
  const out = {};
  for (const [k, v] of Object.entries(o)) out[k] = typeof v === 'number' ? mm(v) : v;
  return out;
};

export const MODEL_SPECS = {
  /* ------------------------------------------------------------------ АКМ --
   * Kalashnikov, 7.62x39. Overall 880 mm, barrel 415 mm, LOP 340 mm, stamped
   * receiver 275 mm, 30-round magazine 175 mm tall with a pronounced rocker.
   * The silhouette cues, in order of how far away they are still readable:
   * the gas tube riding ABOVE the barrel, the slanted gas block, the front
   * sight tower standing off the barrel, wood furniture, and the slant brake. */
  akm: {
    id: 'akm',
    label: 'АКМ',
    pattern: 'ak',
    signature: 'ak',
    fxClass: 'rifle',
    bore: 0.075,
    rUpper: mm(19.8),
    railRise: mm(26.2),
    zUpperRear: mm(112),
    zUpperFront: mm(-163),
    portZ: mm(-55),
    zBreech: mm(-150),
    zBarrelEnd: mm(-478),
    rBarrel: mm(8.2),
    rChamber: mm(11.8),
    gasAt: mm(-300),
    hgZ0: mm(-175),
    hgZ1: mm(-300),
    hgR: mm(25.2),
    hgSides: 6,
    hgSlots: 0,
    handZ: mm(-238),
    gripZ: mm(12),
    gripAngle: 0.44,
    stockRear: mm(340),
    muzzleKind: 'brake',
    magZ: mm(-78),
    magTilt: 0.16,
    mag: mmAll({ w: 29, d: 69, len: 175, curve: 30 }),
    magSegs: 13,
    opticRise: mm(62),
    opticZ: mm(-30),
    shell: { caseLen: 0.0388, rimR: 0.00565 },
    features: [
      'gasTube', 'dustCover', 'sideRail', 'woodFurniture', 'fixedStock', 'slingLoop',
      'akFrontTower', 'akGasBlock', 'slantBrake', 'akSafetyLever', 'akRivets', 'akMagCatch',
    ],
    rollmarks: [{ x: -0.0155, y: 0.0338, z: mm(-40), h: 0.0034, pattern: [3, 1, 2, 3, 0, 2, 3, 1] }],
  },

  /* ---------------------------------------------------------------- АК-74 --
   * 5.45x39. Same receiver and length of pull as the АКМ; what changes is the
   * furniture (plum/black polymer, not wood), the ribbed magazine, and the
   * four-port muzzle brake that is a third longer than the АКМ's slant cut. */
  ak74: {
    id: 'ak74',
    label: 'АК-74',
    pattern: 'ak',
    signature: 'ak',
    fxClass: 'rifle',
    bore: 0.075,
    rUpper: mm(19.4),
    railRise: mm(26.2),
    zUpperRear: mm(112),
    zUpperFront: mm(-163),
    portZ: mm(-55),
    zBreech: mm(-150),
    zBarrelEnd: mm(-490),
    rBarrel: mm(7.4),
    rChamber: mm(10.8),
    gasAt: mm(-305),
    hgZ0: mm(-175),
    hgZ1: mm(-305),
    hgR: mm(24.8),
    hgSides: 6,
    hgSlots: 0,
    handZ: mm(-240),
    gripZ: mm(12),
    gripAngle: 0.44,
    stockRear: mm(340),
    muzzleKind: 'comp',
    magZ: mm(-78),
    magTilt: 0.16,
    mag: mmAll({ w: 27.8, d: 66.2, len: 170, curve: 26 }),
    magSegs: 13,
    opticRise: mm(62),
    opticZ: mm(-30),
    shell: { caseLen: 0.0398, rimR: 0.00505 },
    features: [
      'gasTube', 'dustCover', 'sideRail', 'polymerFurniture', 'fixedStock', 'slingLoop',
      'akFrontTower', 'akGasBlock', 'akSafetyLever', 'akRivets', 'akMagCatch', 'magRibs',
    ],
    rollmarks: [{ x: -0.0152, y: 0.0338, z: mm(-40), h: 0.0032, pattern: [2, 3, 3, 1, 0, 3, 2, 2] }],
  },

  /* ----------------------------------------------------------------- M416 --
   * HK416 A5, 14.5 in. Overall 885 mm with the stock out, barrel 368 mm, upper
   * 245 mm, free-float rail 272 mm — the LONG handguard that reaches almost to
   * the muzzle is the single most recognisable thing about it, and the previous
   * spec gave it 253 mm of receiver and 212 mm of magazine instead. STANAG
   * magazines are 190 mm and nearly STRAIGHT: 14 mm of sagitta against the AK's
   * 30 is what stops the two rifles sharing a silhouette. */
  m416: {
    id: 'm416',
    label: 'M416',
    pattern: 'ar',
    signature: 'ar',
    fxClass: 'carbine',
    bore: 0.075,
    rUpper: mm(19.2),
    railRise: mm(28.6),
    zUpperRear: mm(100),
    zUpperFront: mm(-145),
    portZ: mm(-50),
    zBreech: mm(-128),
    zBarrelEnd: mm(-455),
    rBarrel: mm(7.7),
    rChamber: mm(11.2),
    gasAt: mm(-330),
    hgZ0: mm(-148),
    hgZ1: mm(-420),
    hgR: mm(23.8),
    hgSides: 8,
    hgSlots: 5,
    handZ: mm(-262),
    gripZ: mm(15),
    gripAngle: 0.38,
    stockRear: mm(330),
    muzzleKind: 'brake',
    magZ: mm(-60),
    magTilt: 0.04,
    mag: mmAll({ w: 29.2, d: 67.2, len: 190, curve: 14 }),
    magSegs: 13,
    opticRise: mm(67),
    opticZ: mm(-22),
    shell: { caseLen: 0.0446, rimR: 0.00495 },
    features: [
      'railedHandguard', 'buis', 'qdSocket', 'slingLoop', 'boltCatch', 'brassDeflector',
      'bufferTube', 'castleNut', 'arStock', 'forwardAssist', 'magwellFence', 'birdcage',
      'dustCoverDoor', 'lowProfileGasBlock',
    ],
    rollmarks: [
      { x: -0.0149, y: 0.0355, z: mm(-46), h: 0.0036 },
      { x: -0.0149, y: 0.0295, z: mm(-46), h: 0.0026, pattern: [2, 3, 1, 0, 2, 2, 3, 0, 3, 2] },
    ],
  },

  /* --------------------------------------------------------------- SCAR-H --
   * FN SCAR-H, 7.62x51, 16 in. Overall 889 mm folded-stock-extended, monolithic
   * upper 330 mm — by far the longest receiver in the roster, and the reason a
   * SCAR reads as "one long extruded body" rather than as an AR. */
  scar: {
    id: 'scar',
    label: 'SCAR-H',
    pattern: 'battle',
    signature: 'scar',
    fxClass: 'rifle',
    bore: 0.075,
    rUpper: mm(20.6),
    railRise: mm(30.2),
    zUpperRear: mm(105),
    zUpperFront: mm(-225),
    portZ: mm(-70),
    zBreech: mm(-190),
    zBarrelEnd: mm(-505),
    rBarrel: mm(8.6),
    rChamber: mm(12.4),
    gasAt: mm(-330),
    hgZ0: mm(-230),
    hgZ1: mm(-400),
    hgR: mm(26.2),
    hgSides: 8,
    hgSlots: 5,
    handZ: mm(-300),
    gripZ: mm(18),
    gripAngle: 0.36,
    stockRear: mm(336),
    muzzleKind: 'a2',
    magZ: mm(-80),
    magTilt: 0.05,
    mag: mmAll({ w: 30.8, d: 72.4, len: 200, curve: 10 }),
    magSegs: 12,
    opticRise: mm(71),
    opticZ: mm(-30),
    shell: { caseLen: 0.0512, rimR: 0.00595 },
    features: [
      'railedHandguard', 'foldingStock', 'adjustableCheek', 'ambiCharging', 'qdSocket',
      'slingLoop', 'monolithicRail', 'sideCharging', 'scarTruss', 'polymerLower',
    ],
    rollmarks: [{ x: -0.016, y: 0.0362, z: mm(-60), h: 0.0034, pattern: [3, 2, 0, 3, 1, 2, 3, 3] }],
  },

  /* ------------------------------------------------------------------ СВД --
   * Dragunov, 7.62x54R. Overall 1225 mm, barrel 620 mm, LOP 467 mm. The longest
   * weapon here by 300 mm, and the only one whose stock is a skeletonised
   * thumbhole — cut out, not a slab, which is exactly why a slab read wrong. */
  svd: {
    id: 'svd',
    label: 'СВД',
    pattern: 'dmr',
    signature: 'svd',
    fxClass: 'rifle',
    bore: 0.079,
    rUpper: mm(20.2),
    railRise: mm(26.8),
    zUpperRear: mm(130),
    zUpperFront: mm(-175),
    portZ: mm(-60),
    zBreech: mm(-160),
    zBarrelEnd: mm(-700),
    rBarrel: mm(7.9),
    rChamber: mm(12.6),
    gasAt: mm(-430),
    hgZ0: mm(-180),
    hgZ1: mm(-330),
    hgR: mm(27.2),
    hgSides: 6,
    hgSlots: 0,
    handZ: mm(-255),
    gripZ: mm(20),
    gripAngle: 0.4,
    stockRear: mm(467),
    muzzleKind: 'comp',
    magZ: mm(-85),
    magTilt: 0.12,
    mag: mmAll({ w: 29.6, d: 74.2, len: 130, curve: 18 }),
    magSegs: 9,
    opticRise: mm(58),
    opticZ: mm(-24),
    shell: { caseLen: 0.0535, rimR: 0.0063 },
    features: [
      'gasTube', 'sideRail', 'woodFurniture', 'thumbholeStock', 'cheekRest', 'slingLoop',
      'bipodLug', 'svdVentedHandguard', 'svdFlashHider', 'longBarrel',
    ],
    rollmarks: [{ x: -0.0158, y: 0.0352, z: mm(-46), h: 0.0032, pattern: [3, 3, 1, 2, 0, 3, 2, 1] }],
  },

  /* ------------------------------------------------------------------ MP5 --
   * H&K MP5A3, 9x19. Overall 680 mm with the stock out, barrel 225 mm, receiver
   * only 220 mm — and a 30-round magazine 235 mm long, i.e. LONGER than the
   * receiver it feeds. That inversion is genuinely how an MP5 looks, and it is
   * the cheapest possible way to make it unmistakable beside a rifle. */
  mp5: {
    id: 'mp5',
    label: 'MP5',
    pattern: 'smg',
    signature: 'mp5',
    fxClass: 'smg',
    bore: 0.071,
    rUpper: mm(17.8),
    railRise: mm(24.8),
    zUpperRear: mm(80),
    zUpperFront: mm(-140),
    portZ: mm(-45),
    zBreech: mm(-125),
    zBarrelEnd: mm(-305),
    rBarrel: mm(6.8),
    rChamber: mm(9.8),
    gasAt: null,
    hgZ0: mm(-145),
    hgZ1: mm(-295),
    hgR: mm(22.6),
    hgSides: 8,
    hgSlots: 2,
    handZ: mm(-220),
    gripZ: mm(10),
    gripAngle: 0.42,
    stockRear: mm(305),
    muzzleKind: 'trilug',
    magZ: mm(-60),
    magTilt: 0.03,
    mag: mmAll({ w: 26, d: 58.2, len: 235, curve: 16 }),
    magSegs: 15,
    opticRise: mm(56),
    opticZ: mm(-14),
    shell: { caseLen: 0.0192, rimR: 0.00478 },
    features: [
      'tubularReceiver', 'wrapHandguard', 'rollerDelay', 'collapsingStock', 'clawMount',
      'slingLoop', 'mp5CockingTube', 'mp5DrumSight', 'mp5Slap', 'paddleRelease', 'triLugBarrel',
    ],
    rollmarks: [{ x: -0.0138, y: 0.0308, z: mm(-30), h: 0.0028, pattern: [2, 2, 3, 0, 1, 3, 2] }],
  },

  /* ----------------------------------------------------------------- M870 --
   * Remington 870, 12 gauge, 18.5 in. Receiver only 200 mm; almost everything
   * forward of it is the pair of concentric tubes — barrel over magazine — that
   * no other weapon in the roster has. */
  m870: {
    id: 'm870',
    label: 'M870',
    pattern: 'pump',
    signature: 'pump',
    fxClass: 'shotgun',
    bore: 0.073,
    rUpper: mm(22.4),
    railRise: mm(28.8),
    zUpperRear: mm(90),
    zUpperFront: mm(-110),
    portZ: mm(-40),
    zBreech: mm(-100),
    zBarrelEnd: mm(-560),
    rBarrel: mm(10.6),
    rChamber: mm(14.2),
    gasAt: null,
    hgZ0: mm(-190),
    hgZ1: mm(-330),
    hgR: mm(26.8),
    hgSides: 8,
    hgSlots: 0,
    handZ: mm(-260),
    gripZ: mm(16),
    gripAngle: 0.46,
    stockRear: mm(360),
    muzzleKind: 'none',
    magZ: null,
    magTilt: 0,
    mag: { w: 0, d: 0, len: 0, curve: 0 },
    magSegs: 0,
    tubeMag: mmAll({ r: 12.8, z0: -130, z1: -480, drop: 21.6 }),
    opticRise: mm(60),
    opticZ: mm(-18),
    shell: { caseLen: 0.0699, rimR: 0.00985 },
    features: [
      'tubeMagazine', 'slidingForend', 'actionBars', 'shellLifter', 'ventedRib', 'beadSight',
      'slingLoop', 'woodFurniture', 'forendRibs', 'shellCarrier',
    ],
    rollmarks: [{ x: -0.017, y: 0.0342, z: mm(-30), h: 0.003, pattern: [3, 1, 3, 2, 0, 2, 3] }],
  },

  /* ------------------------------------------------------------- Glock-18 --
   * 9x19, overall 186 mm, barrel 114 mm, slide 174 mm. The squared-off polymer
   * frame with a straight backstrap, the flat-topped slide and the two big
   * serration blocks are the whole identity; there is nothing else to it. */
  glock18: {
    id: 'glock18',
    label: 'Glock-18',
    pattern: 'pistol',
    signature: 'glock',
    fxClass: 'pistol',
    bore: 0.028,
    rUpper: mm(13.1),
    railRise: mm(14.2),
    zUpperRear: mm(48),
    zUpperFront: mm(-122),
    portZ: mm(14),
    zBreech: mm(-8),
    zBarrelEnd: mm(-125),
    rBarrel: mm(6.2),
    rChamber: mm(9.2),
    gasAt: null,
    hgZ0: null,
    hgZ1: null,
    hgR: null,
    hgSides: 0,
    hgSlots: 0,
    handZ: mm(-50),
    gripZ: mm(14),
    gripAngle: 0.32,
    stockRear: null,
    muzzleKind: 'none',
    magZ: mm(6),
    magTilt: 0.1,
    mag: mmAll({ w: 22.4, d: 33.2, len: 105, curve: 3 }),
    magSegs: 4,
    slide: mmAll({ w: 26.2, h: 24.8, len: 174, zRear: 48 }),
    opticRise: mm(26),
    opticZ: mm(12),
    shell: { caseLen: 0.0192, rimR: 0.00478 },
    features: [
      'polymerFrame', 'slideSerrations', 'triggerSafety', 'accessoryRail', 'autoSear',
      'miniReflexMount', 'fingerGrooves', 'squareTriggerGuard', 'glockBackplate',
    ],
    rollmarks: [{ x: -0.0128, y: 0.0332, z: mm(-46), h: 0.0024, pattern: [2, 3, 1, 2, 0, 3] }],
  },

  /* --------------------------------------------------------- Desert Eagle --
   * Mark XIX, .50 AE. Overall 269 mm, barrel 152 mm, slide 215 mm — a pistol
   * that is nearly half again the Glock's length and visibly heavier in every
   * section. Triangular slide, ventilated rib, gas tube under the barrel. */
  deagle: {
    id: 'deagle',
    label: 'Desert Eagle',
    pattern: 'pistol',
    signature: 'deagle',
    fxClass: 'pistol',
    bore: 0.028,
    rUpper: mm(14.6),
    railRise: mm(15.8),
    zUpperRear: mm(62),
    zUpperFront: mm(-155),
    portZ: mm(16),
    zBreech: mm(-6),
    zBarrelEnd: mm(-165),
    rBarrel: mm(8.2),
    rChamber: mm(11.6),
    gasAt: mm(-110),
    hgZ0: null,
    hgZ1: null,
    hgR: null,
    hgSides: 0,
    hgSlots: 0,
    handZ: mm(-60),
    gripZ: mm(16),
    gripAngle: 0.3,
    stockRear: null,
    muzzleKind: 'none',
    magZ: mm(8),
    magTilt: 0.08,
    mag: mmAll({ w: 24.6, d: 39.8, len: 112, curve: 3 }),
    magSegs: 4,
    slide: mmAll({ w: 28.8, h: 28.6, len: 215, zRear: 62 }),
    opticRise: mm(30),
    opticZ: mm(14),
    shell: { caseLen: 0.0327, rimR: 0.00636 },
    features: [
      'steelFrame', 'gasPiston', 'ventedRib', 'triangularBarrel', 'slideSerrations',
      'miniReflexMount', 'deagleRib', 'wideBackstrap',
    ],
    rollmarks: [{ x: -0.0142, y: 0.0358, z: mm(-60), h: 0.0026, pattern: [3, 2, 2, 0, 3, 1] }],
  },
};

/**
 * `mag.segs` used to live inside the `mag` record, which put an integer segment
 * COUNT next to four lengths in millimetres — so `mmAll` would have scaled it to
 * 7.9 and the magazine would have been built from eight-tenths of a slice. It is
 * a separate field now, and this shim keeps the shape the builder and the gate
 * already read.
 */
for (const spec of Object.values(MODEL_SPECS)) spec.mag.segs = spec.magSegs;

export const MODEL_ORDER = [
  'akm',
  'ak74',
  'm416',
  'scar',
  'svd',
  'mp5',
  'm870',
  'glock18',
  'deagle',
];

/** Look up a spec, failing loudly rather than building a half-formed weapon. */
export function specFor(id) {
  const spec = MODEL_SPECS[id];
  if (!spec) throw new Error(`no model spec for "${id}"`);
  return spec;
}

/**
 * Derived layout figures. These are the numbers a person would otherwise write
 * in a comment and then let drift: rail deck height, sight radius, overall
 * length, where the eye sits relative to the glass.
 */
export function layoutOf(spec) {
  const railTop = spec.bore + spec.railRise;
  const opticY = spec.bore + spec.opticRise;
  const rearEnd = spec.stockRear ?? spec.zUpperRear + 0.006;
  const muzzleZ = spec.zBarrelEnd - (spec.muzzleKind === 'none' ? 0 : MUZZLE_LEN[spec.muzzleKind]);
  return {
    railTop,
    opticY,
    muzzleZ,
    overall: rearEnd - muzzleZ,
    barrelLen: spec.zBreech - spec.zBarrelEnd,
    receiverLen: spec.zUpperRear - spec.zUpperFront,
    sightRadius: Math.abs(spec.zUpperRear - spec.zUpperFront),
    // Height of the optic centre over the bore: this is what has to be undone
    // when the sight is zeroed, and what makes a scoped SVD shoot high at 25 m.
    sightOverBore: opticY - spec.bore,
  };
}

/**
 * Muzzle device lengths, mirroring MUZZLE_LEN in src/weapons/parts.js. Kept as a
 * local copy so this file stays importable without three.js; the gate asserts
 * the two tables agree.
 */
export const MUZZLE_LEN = { brake: 0.062, a2: 0.0483, comp: 0.058, trilug: 0.042, none: 0 };

/**
 * Every attachment node the weapons system reads, computed as plain data.
 *
 * The shapes here are NOT invented: they are the ones src/weapons/models/rifle.js
 * publishes, because WeaponSystem and the hand rig consume them directly.
 * Getting one of them subtly wrong (a point where a direction is expected) does
 * not throw — it just puts a hand through the receiver, which is exactly the
 * class of defect this file exists to make testable.
 *
 *   muzzle / chamber / eject     POINTS in weapon-local metres
 *   ejectDir                     DIRECTION the case flies
 *   gripR / gripL                { pos: wrist target, finger: wrap direction,
 *                                  back: dorsum normal } — pos is a point, the
 *                                  other two are directions
 *   handguard                    collision cylinder: a point on the axis, an
 *                                  axis direction, a radius and a z span
 *   chargePull / boltTravel      TRAVEL VECTORS, not scalars
 *   triggerPull                  rotation in radians about triggerPivot
 *   opticGlass                   filled in by build.js from the built optic
 */
export function nodesOf(spec) {
  const L = layoutOf(spec);
  const isPistol = spec.pattern === 'pistol';
  const isPump = spec.pattern === 'pump';
  const isAk = spec.pattern === 'ak' || spec.pattern === 'dmr';

  const nodes = {
    muzzle: [0, spec.bore, L.muzzleZ - 0.002],
    chamber: [0, spec.bore, spec.portZ],
    eject: [spec.rUpper + 0.008, spec.bore + 0.003, spec.portZ],
    // AKs throw brass hard forward-right off a long carrier; a pistol slide
    // flicks it up and back. Same node, three genuinely different vectors.
    ejectDir: isAk ? [0.78, 0.5, 0.38] : isPistol ? [0.7, 0.68, 0.22] : [0.86, 0.44, 0.26],
    sight: [0, L.opticY, spec.opticZ],
    sightAxis: [0, 0, -1],
    ironSight: [
      0,
      L.railTop + (isPistol ? 0.009 : 0.026),
      isPistol ? spec.zUpperRear - 0.008 : spec.zUpperRear - 0.017,
    ],

    // Firing-hand wrist, one grip length behind the receiver face.
    gripR: {
      pos: [0.0251, spec.bore - 0.015, spec.zUpperRear + 0.067],
      finger: [0.05, -0.55, -0.833],
      back: [1, 0.03, 0.04],
    },
    // Support hand: under the handguard on a long gun (clock angle 250 deg, so
    // the hand never covers the muzzle from the camera), wrapped around the
    // firing hand on a pistol.
    gripL: isPistol
      ? {
          pos: [-0.058, spec.bore - 0.008, spec.zUpperRear + 0.05],
          finger: [0.86, -0.34, -0.38],
          back: [-0.3, -0.74, 0.6],
        }
      : {
          pos: [-0.1, spec.bore - 0.0016, spec.handZ + 0.0252],
          finger: [0.8977, -0.3267, -0.2955],
          back: [-0.2784, -0.7648, 0.581],
        },

    handguard: isPistol
      ? { axis: [0, spec.bore, 0], dir: [0, 0, 1], r: 0.015, z0: -0.02, z1: -0.1 }
      : {
          axis: [0, spec.bore, 0],
          dir: [0, 0, 1],
          // The hand touches the polymer slats, which stand 3.6 mm off the chassis.
          r: spec.hgR + 0.0036,
          z0: spec.hgZ0,
          z1: spec.hgZ1,
        },

    magSeat: {
      pos: [0, spec.bore - (isPistol ? 0.052 : 0.014), spec.magZ ?? spec.zUpperFront + 0.02],
      rot: [spec.magTilt, 0, 0],
    },
    magDrop: [0, -0.4, isPump ? 0 : 0.02],

    chargeRest: isPistol
      ? { pos: [0, spec.bore + 0.006, spec.zUpperRear - 0.02], rot: [0, 0, 0] }
      : isAk
        ? { pos: [spec.rUpper + 0.006, spec.bore + 0.004, spec.zUpperRear - 0.03], rot: [0, 0, 0] }
        : isPump
          ? { pos: [0, spec.bore - spec.hgR, spec.handZ], rot: [0, 0, 0] }
          : { pos: [0, spec.bore + spec.rUpper - 0.0075, spec.zUpperRear - 0.024], rot: [0, 0, 0] },
    chargePull: isPistol ? [0, 0, 0.026] : isPump ? [0, 0, 0.086] : [0, 0, 0.082],

    boltRest: { pos: [0, spec.bore, spec.zUpperRear - 0.034], rot: [0, 0, 0] },
    boltTravel: isPistol ? [0, 0, 0.032] : spec.pattern === 'smg' ? [0, 0, 0.056] : [0, 0, 0.062],

    triggerPivot: { pos: [0, spec.bore - 0.0295, spec.gripZ - 0.0205], rot: [0, 0, 0] },
    triggerPull: -0.34,
    selectorPivot: { pos: [0, spec.bore - 0.0225, spec.gripZ + 0.0055], rot: [0, 0, 0] },
  };

  if (isPump) {
    // The forend rides the action bars, so the support hand travels with it.
    nodes.forendRest = { pos: [0, spec.bore - spec.hgR, spec.handZ], rot: [0, 0, 0] };
    nodes.forendTravel = [0, 0, 0.086];
    nodes.shellPort = [0, spec.bore - 0.018, spec.zUpperFront + 0.03];
  }
  if (isAk) {
    // Side mount: the optic hangs off the left of the receiver, not over it.
    nodes.sideRail = {
      pos: [-spec.rUpper - 0.004, spec.bore + 0.016, spec.opticZ],
      rot: [0, 0, 0],
    };
  }
  return nodes;
}

/**
 * A rough triangle estimate per spec, used as a budget guard. The point is not
 * accuracy — it is catching a spec that would build something an order of
 * magnitude heavier than the reference M4A1.
 */
export function triangleEstimate(spec) {
  const L = layoutOf(spec);
  let tris = 2600; // receiver, trigger group, grip
  tris += Math.round(L.barrelLen * 5200); // barrel + bore cavity
  if (spec.hgR) tris += 900 + spec.hgSides * 120 + spec.hgSlots * 180;
  if (spec.mag.len > 0) tris += 700 + spec.mag.segs * 130;
  if (spec.stockRear) tris += 1400;
  if (spec.slide) tris += 1900;
  if (spec.tubeMag) tris += 800;
  if (spec.muzzleKind !== 'none') tris += 620;
  tris += spec.features.length * 210;
  tris += spec.rollmarks.length * 240;

  // The detail pass in detail.js. Before it existed, 23 of the 38 declared
  // features built nothing, so `features.length * 210` above was charging for
  // geometry that was never created and this estimate flattered every spec.
  // These are the features that now cost real triangles, weighted by roughly
  // what each one adds.
  const DETAIL_COST = {
    tubularReceiver: 1800,
    wrapHandguard: 1500,
    collapsingStock: 2100,
    triangularBarrel: 2400,
    gasPiston: 900,
    polymerFrame: 2600,
    steelFrame: 2200,
    boltCatch: 1100,
    brassDeflector: 700,
    ambiCharging: 1400,
    shellLifter: 800,
    autoSear: 600,
    buis: 1300,
    slideSerrations: 2900,
    triggerSafety: 400,
  };
  for (const f of spec.features) tris += DETAIL_COST[f] ?? 0;
  // M-LOK cutouts scale with handguard length, not with a flat feature cost.
  if (spec.features.includes('railedHandguard') && spec.hgR !== null) {
    const slots = Math.max(2, Math.min(6, Math.floor(Math.abs(spec.hgZ1 - spec.hgZ0) / 0.042)));
    tris += slots * 3 * 420;
  }
  return tris;
}

/** Sanity-check a spec's internal consistency. Throws on the first problem. */
export function validateSpec(spec) {
  const L = layoutOf(spec);
  if (spec.zUpperFront >= spec.zUpperRear) throw new Error(`${spec.id}: receiver runs backwards`);
  if (spec.zBarrelEnd >= spec.zBreech) throw new Error(`${spec.id}: barrel runs backwards`);
  if (L.muzzleZ > spec.zBarrelEnd) throw new Error(`${spec.id}: muzzle device points inward`);
  if (spec.rChamber <= spec.rBarrel) throw new Error(`${spec.id}: chamber thinner than the barrel`);
  if (spec.hgR !== null && spec.hgZ1 >= spec.hgZ0) throw new Error(`${spec.id}: handguard runs backwards`);
  if (spec.hgR !== null && spec.hgZ1 < L.muzzleZ) throw new Error(`${spec.id}: handguard overruns the muzzle`);
  if (spec.mag.len > 0 && spec.mag.segs < 3) throw new Error(`${spec.id}: magazine has too few segments`);
  if (spec.opticRise <= 0) throw new Error(`${spec.id}: optic sits inside the receiver`);
  if (!MUZZLE_LEN[spec.muzzleKind]) {
    if (spec.muzzleKind !== 'none') throw new Error(`${spec.id}: unknown muzzle device`);
  }
  return true;
}
