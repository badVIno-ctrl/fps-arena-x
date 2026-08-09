import { ARSENAL_DEFS, ARSENAL_ORDER } from './defs.js';
import { ATTACHMENTS, defaultLoadout } from './attachments.js';

/**
 * ARSENAL — WHAT YOU CAN ACTUALLY CARRY.
 *
 * ---------------------------------------------------------------------------
 * THE DEFECT THIS CLOSES
 * ---------------------------------------------------------------------------
 * `WeaponSystem.weaponIds` returned `[...this.states.keys()]`, and the arsenal
 * registers a state for all nine weapons at init. So Tab and the mouse wheel
 * cycled through the ENTIRE ARSENAL: the player walked into every match carrying
 * an АКМ, an АК-74, an M416, a SCAR-H, an СВД, an MP5, an M870, a Glock and a
 * Desert Eagle simultaneously — 28 kg of iron and 900 rounds. Reported as
 * "надо продумать логику, так чтобы человек не мог взять с собой М416 и калаш,
 * потому что у него в рюкзаке не поместится столько".
 *
 * Weight was already MODELLED — player/load.js turns carried kilograms into
 * speed, ADS time and stamina drain, and it was reading the load of whichever
 * weapon happened to be in hand. It was never LIMITED. So the fix is not a new
 * simulation, it is a budget: decide what fits, and refuse the rest with a
 * reason the player can act on.
 *
 * ---------------------------------------------------------------------------
 * THE MODEL
 * ---------------------------------------------------------------------------
 * Two independent constraints, because in real life they are independent and
 * either one alone gives the wrong answer.
 *
 * 1. CARRY POSITIONS. A soldier has one sling, one holster and a rucksack. Two
 *    full-size rifles is not a weight problem — it is a "there is nowhere to put
 *    it" problem, and it stays impossible however light the rifles are. So:
 *
 *      sling    exactly one full-size long gun   (rifle, battle, dmr, shotgun)
 *      holster  at most one handgun
 *      pack     at most one COMPACT long gun     (an SMG, folded or slung short)
 *
 *    That is what makes "M416 and Kalashnikov" impossible: both want the sling.
 *    An MP5 alongside a rifle is allowed, because a 2.5 kg SMG on a side sling
 *    is a thing people actually do.
 *
 * 2. MASS AND VOLUME. Within those positions you still have to carry the
 *    magazines, and that is where the choices bite: an СВД with eight magazines
 *    and a Desert Eagle is over budget even though every position is legal.
 *
 * Both are reported, and the reason names the constraint that failed — a refusal
 * that only says "no" teaches the player nothing.
 *
 * ---------------------------------------------------------------------------
 * NO three.js, NO ctx, NO DOM
 * ---------------------------------------------------------------------------
 * Pure data and pure functions, so the whole rule set is exercised in node by
 * tools/verify-loadout.mjs. The board and the arsenal both call in here; neither
 * owns a second copy of the arithmetic.
 */

/**
 * Where a weapon rides. Derived from its class rather than declared per weapon,
 * so a tenth weapon inherits the rule instead of needing one.
 */
export function carryPositionFor(def) {
  if (!def) return null;
  if (def.class === 'pistol') return 'holster';
  if (def.class === 'smg') return 'pack';
  return 'sling';
}

/**
 * THE RUCKSACK.
 *
 * `kg` is what an infantryman carries as fighting load before it starts costing
 * real tactical mobility — the usual figure quoted is about a third of body
 * weight, and 22 kg is the low end of that for a 70 kg soldier. It is a CEILING,
 * not a target: player/load.js already penalises everything above
 * REFERENCE_LOAD = 4.6 kg continuously, so the budget's job is only to stop the
 * absurd, not to define the good.
 *
 * `litres` exists because mass alone permits nonsense. Eight СВД magazines weigh
 * 5 kg and would pass a mass-only check, while physically being a brick the size
 * of the pack. Volume is what stops "just take more magazines" from always being
 * the right answer.
 */
export const PACK = {
  kg: 22,
  /**
   * Usable stowage, in litres. 24 rather than the pack's nominal capacity: a
   * rucksack's quoted volume includes the space taken by its own frame, its
   * hydration bladder and the plate carrier it rides over.
   *
   * The figure is chosen so that BOTH constraints are reachable. Ammunition is
   * always mass-bound — a loaded rifle magazine is 0.52 kg in 0.55 l, well above
   * the pack's own 22/24 kg-per-litre — so if volume never binds for anything it
   * is decoration rather than a rule. What it binds on is bulky light kit: a
   * stowed SMG at 9.5 l, smoke and flashbangs, the medical roll. Which is the
   * real trade — "a second gun or a full grenade load, not both".
   */
  litres: 24,
  positions: { sling: 1, holster: 1, pack: 1 },
  /** Litres per spare magazine, by weapon class. */
  magLitres: { rifle: 0.55, smg: 0.45, shotgun: 0.12, pistol: 0.28, dmr: 0.7 },
  /**
   * Loaded magazine mass, in kilograms, by weapon class.
   *
   * A LOCAL COPY of `LOAD.magKg` in player/load.js, and deliberately so: the
   * engine-contract gate forbids `arsenal/` from importing `player/`, which is
   * the rule that keeps the dependency graph a DAG. The same pattern is used for
   * MUZZLE_LEN in models/specs.js — duplicate the handful of numbers, and have a
   * gate assert the two tables agree so the duplication cannot rot silently.
   * tools/verify-loadout.mjs does exactly that.
   */
  magKg: { rifle: 0.52, smg: 0.42, shotgun: 0.06, pistol: 0.28, dmr: 0.62 },
  /** A compact long gun stowed on the pack costs volume as well as mass. */
  stowedLitres: 9.5,
  /** Grenades and the medical kit, which the player also carries. */
  lethalKg: 0.4,
  lethalLitres: 0.6,
  tacticalKg: 0.24,
  tacticalLitres: 0.5,
  medicalKg: 0.45,
  medicalLitres: 1.2,
};

/** Spare magazines a kit carries by default, by weapon class. */
export const DEFAULT_MAGS = { rifle: 6, dmr: 5, smg: 6, shotgun: 4, pistol: 3 };

/**
 * Mass of the fitted attachments on one weapon. `resolveStats` folds attachment
 * mass into `weight` already, but it also folds in a dozen other things and
 * returns a whole stat block; this is the one number, and it is the number the
 * pack cares about.
 */
export function attachmentMass(loadout) {
  let kg = 0;
  for (const id of Object.values(loadout ?? {})) {
    if (!id) continue;
    kg += ATTACHMENTS[id]?.mass ?? 0;
  }
  return kg;
}

/**
 * Everything one weapon costs the pack: the weapon, its attachments, and the
 * spare magazines it needs to be worth carrying.
 */
export function weaponCost(weaponId, { loadout = null, mags = null } = {}) {
  const def = ARSENAL_DEFS[weaponId];
  if (!def) return { kg: 0, litres: 0, mags: 0, def: null };
  const cls = def.class;
  const n = mags ?? DEFAULT_MAGS[cls] ?? 4;
  const magKg = PACK.magKg[cls] ?? PACK.magKg.rifle;
  const magL = PACK.magLitres[cls] ?? PACK.magLitres.rifle;
  const attKg = attachmentMass(loadout ?? defaultLoadout(def));
  return {
    def,
    mags: n,
    kg: def.weight + attKg + n * magKg,
    // Only the SPARE ammunition takes up pack volume; the weapon itself is slung
    // or holstered, except when it is stowed (added by `validateKit`).
    litres: n * magL,
    attachKg: attKg,
  };
}

/**
 * @typedef {object} Kit
 * @property {string[]} weapons     weapon ids the player intends to carry
 * @property {Record<string,object>} [loadouts]  weaponId -> attachment loadout
 * @property {Record<string,number>} [mags]      weaponId -> spare magazine count
 * @property {number} [lethal]      grenades
 * @property {number} [tactical]    flashbangs / smoke
 * @property {boolean} [medical]    carrying the medical kit
 */

/**
 * Is this kit carryable? Returns the full accounting either way — a board that
 * can only say "no" is a board the player argues with.
 *
 * @param {Kit} kit
 * @returns {{ok: boolean, reason: string|null, code: string|null, kg: number,
 *   litres: number, limitKg: number, limitLitres: number,
 *   positions: Record<string, string[]>, items: object[]}}
 */
export function validateKit(kit) {
  const ids = [...new Set(kit?.weapons ?? [])];
  const positions = { sling: [], holster: [], pack: [] };
  const items = [];
  let kg = 0;
  let litres = 0;

  for (const id of ids) {
    const def = ARSENAL_DEFS[id];
    if (!def) {
      return fail(`Неизвестное оружие: ${id}`, 'unknown', kg, litres, positions, items);
    }
    const pos = carryPositionFor(def);
    positions[pos].push(id);
    const cost = weaponCost(id, {
      loadout: kit?.loadouts?.[id] ?? null,
      mags: kit?.mags?.[id] ?? null,
    });
    // A compact long gun in the pack costs its own volume; a slung rifle and a
    // holstered pistol are carried on the body and cost none.
    const extraL = pos === 'pack' ? PACK.stowedLitres : 0;
    kg += cost.kg;
    litres += cost.litres + extraL;
    items.push({ id, label: def.label, position: pos, kg: cost.kg, litres: cost.litres + extraL, mags: cost.mags });
  }

  const lethal = kit?.lethal ?? 0;
  const tactical = kit?.tactical ?? 0;
  const medical = kit?.medical !== false;
  kg += lethal * PACK.lethalKg + tactical * PACK.tacticalKg + (medical ? PACK.medicalKg : 0);
  litres +=
    lethal * PACK.lethalLitres + tactical * PACK.tacticalLitres + (medical ? PACK.medicalLitres : 0);

  // ---- positions, first: these are hard and no diet fixes them --------------
  for (const [pos, limit] of Object.entries(PACK.positions)) {
    const held = positions[pos];
    if (held.length <= limit) continue;
    const names = held.map((id) => ARSENAL_DEFS[id].label).join(' + ');
    const reason =
      pos === 'sling'
        ? `${names}: два длинных ствола не унести — ремень один. Оставь что-то одно.`
        : pos === 'holster'
          ? `${names}: кобура одна.`
          : `${names}: в рюкзаке место только под один компактный ствол.`;
    return fail(reason, `position:${pos}`, kg, litres, positions, items);
  }

  // ---- then the budget -----------------------------------------------------
  if (kg > PACK.kg) {
    return fail(
      `Перегруз: ${kg.toFixed(1)} кг из ${PACK.kg} кг. Убери магазины или ствол.`,
      'mass',
      kg,
      litres,
      positions,
      items,
    );
  }
  if (litres > PACK.litres) {
    return fail(
      `Не влезает: ${litres.toFixed(1)} л из ${PACK.litres} л рюкзака.`,
      'volume',
      kg,
      litres,
      positions,
      items,
    );
  }

  return {
    ok: true,
    reason: null,
    code: null,
    kg,
    litres,
    limitKg: PACK.kg,
    limitLitres: PACK.litres,
    positions,
    items,
  };
}

function fail(reason, code, kg, litres, positions, items) {
  return {
    ok: false,
    reason,
    code,
    kg,
    litres,
    limitKg: PACK.kg,
    limitLitres: PACK.litres,
    positions,
    items,
  };
}

/**
 * Would adding `weaponId` to this kit be legal, and if not, what has to go?
 *
 * The board needs this to answer a click BEFORE it changes anything, and it needs
 * the displaced weapon so it can offer the swap rather than the refusal — "два
 * длинных ствола не унести" is a better message when the button next to it says
 * "заменить АКМ".
 */
export function canAdd(kit, weaponId) {
  const def = ARSENAL_DEFS[weaponId];
  if (!def) return { ok: false, reason: `Неизвестное оружие: ${weaponId}`, displaces: null };
  const current = [...new Set(kit?.weapons ?? [])];
  if (current.includes(weaponId)) return { ok: true, reason: null, displaces: null, already: true };

  const pos = carryPositionFor(def);
  const occupying = current.filter((id) => carryPositionFor(ARSENAL_DEFS[id]) === pos);
  const limit = PACK.positions[pos] ?? 1;

  // A full position is a SWAP, not a refusal — that is what a real player means
  // when they click a second rifle.
  const displaces = occupying.length >= limit ? occupying[occupying.length - 1] : null;
  const next = displaces
    ? current.filter((id) => id !== displaces).concat(weaponId)
    : current.concat(weaponId);

  const v = validateKit({ ...kit, weapons: next });
  return { ok: v.ok, reason: v.reason, displaces, resulting: next, accounting: v };
}

/**
 * Add a weapon, displacing whatever it has to. Returns a NEW kit — the board
 * keeps its own state and must be able to preview a change without committing.
 */
export function withWeapon(kit, weaponId) {
  const r = canAdd(kit, weaponId);
  if (!r.ok) return { kit, ...r };
  return { kit: { ...kit, weapons: r.resulting }, ...r };
}

/** Remove a weapon. Refuses to leave the player with nothing to shoot. */
export function withoutWeapon(kit, weaponId) {
  const next = (kit?.weapons ?? []).filter((id) => id !== weaponId);
  if (!next.length) {
    return { kit, ok: false, reason: 'Нельзя выйти в поле без оружия.', code: 'empty' };
  }
  return { kit: { ...kit, weapons: next }, ok: true, reason: null };
}

/**
 * The kit a new player starts with: one rifle, one SMG in the pack, one pistol.
 *
 * Deliberately the legal maximum in positions and comfortably inside the mass
 * budget, so the first thing a player sees on the board is a valid kit with room
 * to make it worse — which is how they learn there is a budget at all.
 */
export function defaultKit() {
  return {
    weapons: ['akm', 'mp5', 'glock18'],
    mags: {},
    loadouts: {},
    lethal: 2,
    tactical: 1,
    medical: true,
  };
}

/** Every weapon, tagged with whether it could be added to this kit right now. */
export function availability(kit) {
  return ARSENAL_ORDER.map((id) => {
    const carried = (kit?.weapons ?? []).includes(id);
    const r = carried ? { ok: true, reason: null, displaces: null } : canAdd(kit, id);
    return {
      id,
      label: ARSENAL_DEFS[id].label,
      position: carryPositionFor(ARSENAL_DEFS[id]),
      carried,
      ok: r.ok,
      reason: r.reason,
      displaces: r.displaces ?? null,
    };
  });
}
