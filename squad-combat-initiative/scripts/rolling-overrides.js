/****************************************************************************************
 * rolling‑overrides.js ‑‑ Group‑based initiative roll patching
 * --------------------------------------------------------------------------------------
 *  - Injects our group‑average initiative logic into Combat.rollAll / Combat.rollNPC
 *  - Falls back gracefully if libWrapper is absent
 *  - Exposes tiny i18n helpers used by several UI files
 ****************************************************************************************/

import { MODULE_ID, log } from "./shared.js";
import { GroupManager } from "./class-objects.js";

/* ------------------------------------------------------------------ */
/*  Cached Intl helpers (creating new ones every call is wasteful)    */
/* ------------------------------------------------------------------ */
let _pluralRules;
let _numFormatter;

/** Localised plural‑rules helper (lazy‑loads once) */
export function getPluralRules() {
    if (!_pluralRules) _pluralRules = new Intl.PluralRules(game.i18n.lang);
    return _pluralRules;
}

/** Localised number formatter (lazy‑loads once) */
export function formatNumber(n, opts = {}) {
    if (!_numFormatter) _numFormatter = new Intl.NumberFormat(game.i18n.lang, opts);
    return _numFormatter.format(n);
}

/* ------------------------------------------------------------------ */
/*  Combat roll patching                                              */
/* ------------------------------------------------------------------ */

export let wrapped = false;   // hard guard – ensures we patch only once

/**
 * Patch Combat.rollAll / Combat.rollNPC so they always invoke
 * GroupManager.rollGroupInitiative, guaranteeing group‑average logic.
 *
 * Can be called safely multiple times (first call wins).
 * Should be triggered *once* during ready/first combat creation.
 */
export function overrideRollMethods() {
    if (wrapped) return;
    wrapped = true;

    const mod = game.modules.get(MODULE_ID);
    mod.__groupSortWrappersRegistered = false;

    if (game.modules.get("lib-wrapper")?.active) {
        const register = method => {
            libWrapper.register(
                MODULE_ID,
                `Combat.prototype.${method}`,
                async function wrappedRoll(_next, ...args) {
                    await _next(...args);

                    // Only run once per rollAll()/rollNPC() call
                    if (this._groupInitiativeProcessed) return;
                    this._groupInitiativeProcessed = true;

                    try {
                        // ① Build a Map of all groups (including UNGROUPED)
                        const groups = GroupManager.getGroups(this.turns, this);
                        // ② For each actual group, finalize & whisper
                        for (const [groupId] of groups.entries()) {
                            if (groupId === UNGROUPED) continue;
                            await GroupManager.finalizeGroupInitiative(this, groupId);
                        }
                    } finally {
                        // clean up the flag on next tick
                        setTimeout(() => delete this._groupInitiativeProcessed, 0);
                    }
                },
                libWrapper.MIXED
            );
        };

        register("rollAll");
        register("rollNPC");
        mod.__groupSortWrappersRegistered = true;
        log("✅ rollAll / rollNPC wrapped for multi-group summaries");
        return;
    }

    /* Fallback – monkey‑patch the *instance* methods created after this point.
       Note: we cannot patch Combat.prototype directly without risking clashes,
       so we re‑define on the active combat (and any new ones should call
       overrideRollMethods() early). */
    const fallback = (combat, fn) => combat[fn] = async function (..._args) {
        log(`(Fallback) ${fn} intercepted`);
        await GroupManager.rollGroupInitiative(this);
    };

    Hooks.on("combatStart", (combat) => {
        fallback(combat, "rollAll");
        fallback(combat, "rollNPC");
    });

    console.log("⚠️ libWrapper not active – using fallback monkey‑patch");
}

