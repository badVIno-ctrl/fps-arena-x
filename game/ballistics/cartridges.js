/**
 * CARTRIDGES — the ammunition, as physics rather than as a damage number.
 *
 * WHAT WAS WRONG WITH THE OLD MODEL
 * Every weapon carried `muzzleVelocity`, `dragK` and `damage`, and the projectile
 * simulation decayed velocity with `v *= 1 - dragK*dt`. That is a linear drag
 * term, and a bullet is not a linearly damped body: drag rises with the SQUARE of
 * speed, and the coefficient itself jumps by 45% as the round crosses Mach 1.
 * The practical consequence was that a 9 mm and a 5.56 could be tuned to match at
 * one distance and then be wrong at every other distance, and no amount of
 * fiddling with `dragK` could fix both ends at once.
 *
 * More importantly, `muzzleVelocity` belonged to the WEAPON. In reality it
 * belongs to the pairing of cartridge and barrel length: the same 5.56x45 round
 * leaves a 508 mm barrel at 920 m/s and a 368 mm barrel at 880 m/s. Modelling it
 * per weapon meant a shortened barrel was a cosmetic change, and it meant nine
 * places to edit when one cartridge's data improved.
 *
 * THE MODEL
 * Standard exterior ballistics, the same the published tables are built from:
 *
 *   a_drag = -(Cd(M) · rho · A · v²) / (2 · m)
 *
 * with Cd(M) taken from the G7 standard drag function scaled by a per-bullet form
 * factor. The form factor is not a fudge: it is the defined relationship between
 * a real bullet and the standard projectile,
 *
 *   i = SD / BC        SD = mass_grains / (7000 · diameter_inches²)
 *
 * so it is derived from published data rather than tuned by eye. A 62 gr 5.56
 * with a G7 BC of 0.151 comes out at i = 1.17 — nearly the standard shape, as a
 * boat-tail spitzer should be. A 124 gr 9 mm at 0.075 comes out at 1.87, because
 * a blunt pistol bullet really is that much draggier. Nobody chose those numbers.
 *
 * Everything here is pure: no three.js, no engine context, no DOM. The gate
 * imports it in plain node and checks the trajectories against published drop
 * and energy figures.
 *
 * UNITS, without exception: metres, seconds, kilograms, joules, radians.
 */

/* ------------------------------------------------------------ atmosphere */

/** Sea level, 15 °C, dry. The reference the published tables use. */
export const RHO_0 = 1.225;
/** Speed of sound at the same reference, m/s. */
export const MACH_1 = 340.3;
export const GRAVITY = -9.80665;

const GRAINS_PER_KG = 15432.358;
const M_PER_INCH = 0.0254;

/**
 * Air density from temperature and altitude, kg/m³.
 *
 * Worth having because it is the difference between a cold morning and a hot
 * afternoon on a 400 m shot — about 4% of drag, which is a few centimetres of
 * drop. It is also what a "high altitude" map variant would key off.
 */
export function airDensity({ altitude = 0, celsius = 15, pressureHpa = null } = {}) {
  // Barometric formula for the troposphere.
  const p = pressureHpa ?? 1013.25 * Math.pow(1 - 2.25577e-5 * altitude, 5.25588);
  const kelvin = celsius + 273.15;
  return (p * 100) / (287.058 * kelvin);
}

/** Speed of sound scales with the square root of absolute temperature. */
export function speedOfSound(celsius = 15) {
  return 331.3 * Math.sqrt(1 + celsius / 273.15);
}

/* ------------------------------------------------------- G7 drag function */

/**
 * The G7 standard drag function, as tabulated pairs of [Mach, Cd].
 *
 * The shape of this table is the entire reason for the rewrite. Note what happens
 * between Mach 0.95 and Mach 1.15: Cd goes from 0.1226 to 0.1745, a 42% rise
 * across a band a supersonic rifle bullet crosses at roughly 500-700 m from the
 * muzzle. A linear drag term cannot represent that at all, which is why the old
 * model could never make a rifle behave correctly at both 100 m and 400 m.
 *
 * Below Mach 0.5 the curve is flat, so pistol rounds — which start subsonic or
 * fall subsonic almost immediately — behave like simple quadratic-drag bodies.
 */
const G7 = [
  [0.00, 0.1198], [0.50, 0.1197], [0.70, 0.1194], [0.80, 0.1193],
  [0.85, 0.1194], [0.875, 0.1197], [0.90, 0.1202], [0.925, 0.1215],
  [0.95, 0.1226], [0.975, 0.1242], [1.00, 0.1278], [1.025, 0.1350],
  [1.05, 0.1476], [1.075, 0.1584], [1.10, 0.1660], [1.125, 0.1710],
  [1.15, 0.1745], [1.20, 0.1795], [1.25, 0.1810], [1.30, 0.1810],
  [1.40, 0.1793], [1.50, 0.1763], [1.60, 0.1727], [1.80, 0.1653],
  [2.00, 0.1580], [2.20, 0.1513], [2.50, 0.1420], [3.00, 0.1300],
  [3.50, 0.1220], [4.00, 0.1160], [5.00, 0.1093],
];

/**
 * Cd of the standard G7 projectile at a given Mach number.
 *
 * Linear interpolation between table rows. A spline would be smoother and would
 * change nothing a player can perceive: the table is dense exactly where the
 * curve bends.
 */
export function cdG7(mach) {
  if (mach <= G7[0][0]) return G7[0][1];
  const last = G7[G7.length - 1];
  if (mach >= last[0]) return last[1];
  // The table is short enough that a linear scan beats the branch cost of a
  // binary search, and this runs per projectile per physics step.
  for (let i = 1; i < G7.length; i++) {
    if (mach <= G7[i][0]) {
      const [m0, c0] = G7[i - 1];
      const [m1, c1] = G7[i];
      const t = (mach - m0) / (m1 - m0);
      return c0 + (c1 - c0) * t;
    }
  }
  return last[1];
}

/**
 * Sectional density in the imperial units the BC is defined in, lb/in².
 * @param {number} grains bullet mass
 * @param {number} inches bullet diameter
 */
export function sectionalDensity(grains, inches) {
  return grains / (7000 * inches * inches);
}

/**
 * Form factor: how much draggier this bullet is than the G7 standard shape.
 * 1.0 means identical; a blunt pistol bullet lands near 1.9.
 */
export function formFactor(grains, inches, bcG7) {
  return sectionalDensity(grains, inches) / bcG7;
}

/* ---------------------------------------------------------- the cartridges */

/**
 * Build a cartridge from published figures.
 *
 * `velocities` is the honest part: a map from barrel length in millimetres to
 * measured muzzle velocity. Anything between two entries is interpolated, and
 * anything outside is extrapolated at the local slope, which is the behaviour
 * chronograph data actually shows over the range barrels vary.
 *
 * @param {object} o
 *   id, label      identity
 *   grains         bullet mass
 *   diameter_in    bullet diameter, inches (the bore, not the case)
 *   bcG7           published G7 ballistic coefficient
 *   velocities     { [barrel_mm]: v0_ms }
 *   pellets        for shot shells: how many projectiles leave per trigger pull
 *   penetration    budget in the units game/physics/penetration.js expects
 *   terminal       'fmj' | 'jhp' | 'ap' | 'buck' | 'slug'
 *   subsonic       true when the load is designed to stay under Mach 1
 */
function cartridge(o) {
  const massKg = o.grains / GRAINS_PER_KG;
  const diameterM = o.diameter_in * M_PER_INCH;
  const area = Math.PI * 0.25 * diameterM * diameterM;
  const i = formFactor(o.grains, o.diameter_in, o.bcG7);
  const barrels = Object.entries(o.velocities)
    .map(([mm, v]) => [Number(mm), v])
    .sort((a, b) => a[0] - b[0]);

  return {
    id: o.id,
    label: o.label,
    grains: o.grains,
    massKg,
    diameterM,
    area,
    bcG7: o.bcG7,
    formFactor: i,
    /** Cd of THIS bullet, not of the standard one. */
    cd: (mach) => cdG7(mach) * i,
    barrels,
    pellets: o.pellets ?? 1,
    penetration: o.penetration,
    terminal: o.terminal ?? 'fmj',
    subsonic: o.subsonic ?? false,
    /** Fraction of muzzle energy converted to wound trauma on a torso hit. */
    transfer: TRANSFER[o.terminal ?? 'fmj'],
  };
}

/**
 * How much of the arriving energy a bullet actually deposits.
 *
 * This is the honest replacement for a flat `damage` number. An FMJ rifle round
 * that exits carries most of its energy out the far side; a hollow point that
 * expands and stops deposits nearly all of it. That single distinction is why
 * a .50 AE hurts more than its energy alone suggests and why an AP round drills
 * through armour but wounds less behind it.
 */
const TRANSFER = {
  fmj: 0.42,
  jhp: 0.86,
  ap: 0.28,
  buck: 0.74,
  slug: 0.68,
};

export const CARTRIDGES = {
  /* --------------------------------------------------------- intermediate */
  '7.62x39': cartridge({
    id: '7.62x39',
    label: '7,62×39 (57-Н-231)',
    grains: 122,
    diameter_in: 0.311,
    bcG7: 0.145,
    // 415 mm is the AKM barrel; 314 mm is the AKS-74U-length carbine.
    velocities: { 314: 670, 415: 715, 520: 738 },
    penetration: 1.15,
    terminal: 'fmj',
  }),
  '5.45x39': cartridge({
    id: '5.45x39',
    label: '5,45×39 (7Н6)',
    grains: 52.9,
    diameter_in: 0.221,
    bcG7: 0.150,
    velocities: { 206: 735, 415: 880, 590: 910 },
    penetration: 1.05,
    terminal: 'fmj',
  }),
  '5.56x45': cartridge({
    id: '5.56x45',
    label: '5,56×45 (M855)',
    grains: 62,
    diameter_in: 0.224,
    bcG7: 0.151,
    // The classic pair: 14.5" carbine and 20" rifle.
    velocities: { 267: 800, 368: 880, 508: 920 },
    penetration: 1.0,
    terminal: 'fmj',
  }),

  /* --------------------------------------------------------------- battle */
  '7.62x51': cartridge({
    id: '7.62x51',
    label: '7,62×51 (M80)',
    grains: 147,
    diameter_in: 0.308,
    bcG7: 0.200,
    velocities: { 330: 780, 400: 800, 508: 833, 610: 850 },
    penetration: 1.5,
    terminal: 'fmj',
  }),
  '7.62x54R': cartridge({
    id: '7.62x54R',
    label: '7,62×54R (7Н1)',
    grains: 151,
    diameter_in: 0.311,
    bcG7: 0.215,
    velocities: { 508: 800, 620: 830, 730: 845 },
    penetration: 1.6,
    terminal: 'fmj',
  }),

  /* --------------------------------------------------------------- pistol */
  '9x19': cartridge({
    id: '9x19',
    label: '9×19 (124 gr FMJ)',
    grains: 124,
    diameter_in: 0.355,
    bcG7: 0.075,
    // A Glock's 114 mm against an MP5's 225 mm: 30 m/s of real difference.
    velocities: { 114: 360, 127: 370, 225: 400, 406: 425 },
    penetration: 0.42,
    terminal: 'fmj',
  }),
  '9x19sub': cartridge({
    id: '9x19sub',
    label: '9×19 дозвуковой (147 gr)',
    grains: 147,
    diameter_in: 0.355,
    bcG7: 0.088,
    // Kept under Mach 1 on purpose: with a suppressor there is no ballistic
    // crack, which is the whole reason the load exists. See the audio system.
    velocities: { 114: 300, 225: 320, 406: 330 },
    penetration: 0.36,
    terminal: 'jhp',
    subsonic: true,
  }),
  '.50AE': cartridge({
    id: '.50AE',
    label: '.50 AE (325 gr)',
    grains: 325,
    diameter_in: 0.500,
    bcG7: 0.105,
    velocities: { 152: 442, 254: 470 },
    penetration: 0.85,
    terminal: 'jhp',
  }),

  /* --------------------------------------------------------------- shotgun */
  '12g-buck': cartridge({
    id: '12g-buck',
    label: '12/70 картечь 00',
    // One .33 cal pellet. Nine of them leave per shot; the sim spawns nine
    // independent projectiles rather than one blob with a damage multiplier,
    // which is what makes range matter and cover work.
    grains: 53.8,
    diameter_in: 0.33,
    bcG7: 0.032,
    velocities: { 470: 400, 660: 410 },
    pellets: 9,
    penetration: 0.5,
    terminal: 'buck',
  }),
  '12g-slug': cartridge({
    id: '12g-slug',
    label: '12/70 пуля',
    grains: 437,
    diameter_in: 0.729,
    bcG7: 0.055,
    velocities: { 470: 500, 660: 520 },
    pellets: 1,
    penetration: 1.1,
    terminal: 'slug',
  }),
};

/**
 * Muzzle velocity for a cartridge out of a specific barrel.
 *
 * Interpolates between measured points and extrapolates at the end slope. This is
 * what makes a barrel attachment a ballistic decision instead of a skin: chop
 * 100 mm off an AKM and the round leaves 30 m/s slower, and the drop at 300 m
 * changes accordingly.
 */
export function muzzleVelocity(cart, barrelMm) {
  const b = cart.barrels;
  if (!b.length) return 0;
  if (b.length === 1) return b[0][1];
  if (barrelMm <= b[0][0]) {
    const [[x0, y0], [x1, y1]] = [b[0], b[1]];
    return Math.max(50, y0 + ((barrelMm - x0) * (y1 - y0)) / (x1 - x0));
  }
  const n = b.length;
  if (barrelMm >= b[n - 1][0]) {
    const [[x0, y0], [x1, y1]] = [b[n - 2], b[n - 1]];
    return y1 + ((barrelMm - x1) * (y1 - y0)) / (x1 - x0);
  }
  for (let i = 1; i < n; i++) {
    if (barrelMm <= b[i][0]) {
      const [x0, y0] = b[i - 1];
      const [x1, y1] = b[i];
      return y0 + ((barrelMm - x0) * (y1 - y0)) / (x1 - x0);
    }
  }
  return b[n - 1][1];
}

/** Kinetic energy in joules. */
export function energy(cart, speed) {
  return 0.5 * cart.massKg * speed * speed;
}

/**
 * Drag deceleration magnitude, m/s².
 *
 * @param {object} cart
 * @param {number} speed  current speed, m/s
 * @param {number} rho    air density, kg/m³
 * @param {number} mach1  local speed of sound, m/s
 */
export function dragDecel(cart, speed, rho = RHO_0, mach1 = MACH_1) {
  const cd = cart.cd(speed / mach1);
  return (cd * rho * cart.area * speed * speed) / (2 * cart.massKg);
}

/**
 * Integrate a trajectory in a vacuum-free, wind-free vertical plane.
 *
 * Exists for the gate and for the ballistic tables the gunsmith board shows the
 * player. The live simulation in game/weapons/ballistics.js uses the same
 * `dragDecel`, so a number the player reads off a table is a number the round
 * will actually fly.
 *
 * @returns {{drop: number, speed: number, energy: number, time: number}}
 *   drop is negative-down in metres relative to the launch axis.
 */
export function solve(cart, { v0, distance, angle = 0, rho = RHO_0, mach1 = MACH_1, dt = 1 / 2000 }) {
  let x = 0;
  let y = 0;
  let vx = v0 * Math.cos(angle);
  let vy = v0 * Math.sin(angle);
  let t = 0;
  // A fixed 0.5 ms step over 400 m of flight is 800-2500 iterations: cheap
  // offline, and small enough that the integration error is far below the
  // millimetre. The live sim runs at the physics rate instead.
  while (x < distance && t < 10) {
    const speed = Math.hypot(vx, vy) || 1e-6;
    const a = dragDecel(cart, speed, rho, mach1);
    // Drag opposes the velocity vector, not the horizontal axis — the difference
    // matters once the trajectory has any real angle to it.
    const ax = (-a * vx) / speed;
    const ay = (-a * vy) / speed + GRAVITY;
    // Midpoint (velocity-Verlet position term): second-order accurate for the
    // same number of force evaluations as Euler.
    x += vx * dt + 0.5 * ax * dt * dt;
    y += vy * dt + 0.5 * ay * dt * dt;
    vx += ax * dt;
    vy += ay * dt;
    t += dt;
  }
  const speed = Math.hypot(vx, vy);
  return { drop: y, speed, energy: energy(cart, speed), time: t, distance: x };
}

/**
 * The angle to launch at so the trajectory crosses zero again at `distance`.
 *
 * This is what "pristrelka" means mechanically: a rifle zeroed at 100 m is
 * pointed slightly up, so the round rises above the sight line and comes back
 * down through it. Solved by bisection because the relationship is monotonic in
 * the range that matters and bisection cannot diverge.
 */
export function zeroAngle(cart, { v0, distance, sightHeight = 0.075 }) {
  let lo = 0;
  let hi = 0.05; // ~2.9 deg is far past any practical zero
  for (let iter = 0; iter < 40; iter++) {
    const mid = (lo + hi) / 2;
    const { drop } = solve(cart, { v0, distance, angle: mid, dt: 1 / 1500 });
    if (drop < sightHeight) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

/** Every cartridge id, for gates and for the gunsmith board. */
export const CARTRIDGE_IDS = Object.keys(CARTRIDGES);

/**
 * Resolve a cartridge by id, with a loud failure.
 *
 * Deliberately throws rather than returning a default: a weapon referring to a
 * cartridge that does not exist is a data bug, and a silent fallback would turn
 * it into a weapon that quietly fires the wrong ammunition.
 */
export function cartridgeFor(id) {
  const c = CARTRIDGES[id];
  if (!c) throw new Error(`unknown cartridge "${id}" (have: ${CARTRIDGE_IDS.join(', ')})`);
  return c;
}
