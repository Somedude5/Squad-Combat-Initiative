
// MODULE IDENTIFIER for our Group-Based Initiative module.
export const MODULE_ID = "squad-combat-initiative";

/**
 * Helper logging function that prints debug messages if logging is enabled.
 * Falls back gracefully if settings are not registered.
 */
export function log(...args) {
  try {
    if (game.settings.get(MODULE_ID, "enableLogging")) {
      console.log(`[${MODULE_ID}]`, ...args);
    }
  } catch (err) {
    console.log(`[${MODULE_ID}] (log fallback)`, ...args);
  }
}

export function generateGroupId() {
  return "gr-" + foundry.utils.randomID();
}

/*  Per-client expand / collapse persistence                       */
export const expandStore = {
  load(combatId) {
    try {
      return new Set(JSON.parse(localStorage.getItem(`${MODULE_ID}.expanded.${combatId}`) || "[]"));
    } catch {
      return new Set();
    }
  },
  save(combatId, set) {
    localStorage.setItem(`${MODULE_ID}.expanded.${combatId}`, JSON.stringify([...set]));
  }
};

/*  Make sure to limit errors on th eplayer end with permissions                      */
export function GMPERMISSIONS() {
  return game.user?.isGM;
}