/*****************************************************************************************
 * class-objects.js ‑‑ GroupManager logic + header context‑menu helpers (refactored v2)
 * ---------------------------------------------------------------------------------------
 *  • Eliminated duplicate flag reads/writes and reduced socket chatter by batching updates.
 *  • Replaced ad‑hoc "ungrouped" magic string with a shared constant.
 *  • Leveraged modern language idioms (Array.from, ??=, optional‑chaining, Object.values).
 *  • Removed unused generateGroupId import.
 *  • Preserved full public API and behaviour.                                                  
 *****************************************************************************************/

import { MODULE_ID, log, GMPERMISSIONS } from "./shared.js";

export const UNGROUPED = "ungrouped";

/* ------------------------------------------------------------------ */
/*  GroupManager                                                      */
/* ------------------------------------------------------------------ */
export class GroupManager {
  static _mutex = false; // protects finalize re‑entrance

  /* ------------------------------------------------------------ */
  /*  Gather combatants into Map<groupId,{name,members[]}>        */
  /* ------------------------------------------------------------ */
  static getGroups(combatants, combat) {
    const stored = foundry.utils.getProperty(combat, `flags.${MODULE_ID}.groups`) ?? {};
    const map = new Map();

    // 1. Bucket combatants by their flag (default UNGROUPED)
    for (const c of combatants) {
      const id = c.getFlag(MODULE_ID, "groupId") ?? UNGROUPED;
      if (!map.has(id)) {
        const data = stored[id] ?? {};
        map.set(id, { name: data.name ?? "Unnamed Group", members: [] });
      }
      map.get(id).members.push(c);
    }

    // 2. Ensure empty groups from flags are still represented
    for (const [gid, data] of Object.entries(stored)) {
      if (!map.has(gid) && gid !== UNGROUPED) {
        map.set(gid, { name: data.name ?? "Unnamed Group", members: [] });
      }
    }

    log("Grouped combatants (by ID)", map);
    return map;
  }

  /* ------------------------------------------------------------ */
  /*  UI roll (normal/adv/dis): roll unset & apply ordering       */
  /* ------------------------------------------------------------ */
  static async rollGroupAndApplyInitiative(combat, groupId, { mode = "normal" } = {}) {
    const groupMeta = combat.getFlag(MODULE_ID, `groups.${groupId}`) ?? {};
    const groupName = groupMeta.name ?? "Unnamed Group";
    const members = combat.combatants.filter(c => c.getFlag(MODULE_ID, "groupId") === groupId);
    const toRoll = members.filter(c => c.initiative == null);

    if (!toRoll.length) {
      return ui.notifications.info(`Group \"${groupName}\" already has initiative.`);
    }
    if (GMPERMISSIONS()) {
      await combat.setFlag(MODULE_ID, `skipFinalize.${groupId}`, true); // safeguard
    }

    const dieExpr = mode === "advantage" ? "2d20kh"
      : mode === "disadvantage" ? "2d20kl"
        : "1d20";

    const rolledSummary = [];
    for (const c of toRoll) {
      const dexMod = c.actor?.system?.abilities?.dex?.mod ?? 0;
      const roll = new Roll(`${dieExpr} + ${dexMod}`);
      await roll.evaluate();

      // Chat
      await roll.toMessage({
        speaker: ChatMessage.getSpeaker({ actor: c.actor }),
        flavor: `${c.name} rolls for Initiative!`,
        rollMode: CONST.DICE_ROLL_MODES.GMROLL
      });

      rolledSummary.push({ combatant: c, name: c.name, init: roll.total, dex: dexMod });
    }


    // Batch initiative updates
    if (GMPERMISSIONS()) {
      await combat.updateEmbeddedDocuments("Combatant", rolledSummary.map(r => ({ _id: r.combatant.id, initiative: r.init })));
    }

    await this._applyGroupOrder(combat, groupId, rolledSummary, { sendSummary: true });
    if (GMPERMISSIONS()) {
      await combat.unsetFlag(MODULE_ID, `skipFinalize.${groupId}`);
    }
  }

  /* ------------------------------------------------------------ */
  /*  Hooked: finalize once *all* members have initiative         */
  /* ------------------------------------------------------------ */
  static async finalizeGroupInitiative(combat, groupId) {
    if (this._mutex) return; // prevent recursive bursts
    this._mutex = true;
    try {
      const members = combat.combatants.filter(c => c.getFlag(MODULE_ID, "groupId") === groupId);
      if (!members.length) return;

      if (!members.every(c => Number.isFinite(c.initiative))) return; // still waiting

      const shaped = members.map(c => ({
        combatant: c,
        name: c.name,
        init: c.initiative,
        dex: c.actor?.system?.abilities?.dex?.value ?? 10
      }));

      await this._applyGroupOrder(combat, groupId, shaped, { sendSummary: true });
    } finally { this._mutex = false; }
  }

  /* ------------------------------------------------------------ */
  /*  Shared: sort, stagger, set flag, create summary (optional)  */
  /* ------------------------------------------------------------ */
  static async _applyGroupOrder(combat, groupId, list, { sendSummary = false } = {}) {
    const meta = combat.getFlag(MODULE_ID, `groups.${groupId}`) ?? {};
    const groupName = meta.name ?? "Unnamed Group";

    // Sort by real initiative, then DEX mod
    list.sort((a, b) => b.init - a.init || b.dex - a.dex);

    const baseSort = (Math.min(...combat.turns.map(t => t.sort ?? 0)) || 0) - 1000;

    // Step 1: Compute the ceiling average
    const avgInit = Math.ceil(list.reduce((sum, r) => sum + r.init, 0) / list.length);

    // Step 2: Assign initiatives
    const updates = list.map((r, idx, arr) => ({
      _id: r.combatant.id,
      sort: baseSort + idx * 100,
      // First gets +0.03, second gets +0.02, third gets +0.01
      initiative: +(avgInit + (arr.length - idx) * 0.01).toFixed(2)
    }));

    // Step 3: Apply updates
    if (GMPERMISSIONS()) {
      await combat.updateEmbeddedDocuments("Combatant", updates);
    }

    // Step 4: Store rounded-up avg in group flags
    if (GMPERMISSIONS()) {
      await combat.setFlag(MODULE_ID, `groups.${groupId}.initiative`, avgInit);
    }

    // Step 5: Optional chat summary
    if (GMPERMISSIONS()) {
      if (sendSummary) {
        const gmIds = game.users.filter(u => u.isGM).map(u => u.id);
        const summaryList = list.map(r => `<li><strong>${r.name}</strong>: ${r.init}</li>`).join("");

        await ChatMessage.create({
          content: `<h3>${groupName} initiative rolled</h3>
                   <p><strong>Group initiative:</strong> ${avgInit}</p>
                   <ul>${summaryList}</ul>`,
          whisper: gmIds,     // whisper only to GMs
          blind: true       // fully hide from non-GMs
        });
      }
    }



    log(`Applied group order for "${groupName}"`, updates);
  }

}

/* ------------------------------------------------------------------ */
/*  Context‑menu helpers for group headers                            */
/* ------------------------------------------------------------------ */
export class GroupContextMenuManager {
  /* -- Public -- */
  static getContextOptions() {
    // if *any* non-GM calls this, give them ZERO options
    if (!game.user.isGM && game.user.role < CONST.USER_ROLES.ASSISTANT) return [];
    return [renameOption(), setInitiativeOption(), deleteOption()];
  }

  /* -- Prompt helper -- */
  static async prompt(title, msg, defVal = "") {
    return new Promise(res => {
      new Dialog({
        title,
        content: `<p>${msg}</p><input type="text" value="${defVal}" style="width:100%">`,
        buttons: {
          ok: { label: "OK", callback: html => res(html.find("input").val().trim()) },
          cancel: { label: "Cancel", callback: () => res(null) }
        },
        default: "ok"
      }).render(true);
    });
  }
}

/* ------------------------------------------------------------------ */
/*  Individual context‑menu option factories                          */
/* ------------------------------------------------------------------ */
function renameOption() {
  return {
    name: "Rename Group",
    icon: "<i class=\"fas fa-edit\"></i>",
    condition: li => game.user.isGM && !!li?.[0]?.closest(".combatant-group"), callback: async li => {
      const groupId = li?.[0]?.closest(".combatant-group")?.dataset?.groupKey;
      const combat = game.combat;
      const group = combat.getFlag(MODULE_ID, `groups.${groupId}`);
      if (!group) return ui.notifications.warn("Could not find group data.");

      const newName = await GroupContextMenuManager.prompt("Rename Group", "Enter a new name:", group.name);
      if (!newName || newName === group.name) return;
      if (GMPERMISSIONS()) {
        await combat.setFlag(MODULE_ID, `groups.${groupId}.name`, newName);
      }
      ui.combat.render();
    }
  };
}

function setInitiativeOption() {
  return {
    name: "Set Group Initiative",
    icon: "<i class=\"fas fa-dice\"></i>",
    condition: li => game.user.isGM && !!li?.[0]?.closest(".combatant-group"), callback: async li => {
      const groupId = li?.[0]?.closest(".combatant-group")?.dataset?.groupKey;
      const combat = game.combat;
      const group = combat.getFlag(MODULE_ID, `groups.${groupId}`);
      const groupName = group?.name ?? "Unnamed Group";

      const val = await GroupContextMenuManager.prompt("Set Initiative", `Enter a new initiative for \"${groupName}\":`, "10");
      const base = Number(val);
      if (!Number.isFinite(base)) return;

      const members = combat.combatants.filter(c => c.getFlag(MODULE_ID, "groupId") === groupId);
      if (!members.length) return;

      const oldAvg = members.reduce((s, c) => s + (c.initiative ?? 0), 0) / members.length || 0;
      const updates = members.map(c => ({ _id: c.id, initiative: base + ((c.initiative ?? 0) - oldAvg) }));
      if (GMPERMISSIONS()) {
        await combat.setFlag(MODULE_ID, `skipFinalize.${groupId}`, true);
      }
      await combat.updateEmbeddedDocuments("Combatant", updates);
      if (GMPERMISSIONS()) {
        await combat.setFlag(MODULE_ID, `groups.${groupId}.initiative`, base);
      }
      if (GMPERMISSIONS()) {
        await combat.unsetFlag(MODULE_ID, `skipFinalize.${groupId}`);
      }
      ui.combat.render();
    }
  };
}

function deleteOption() {
  return {
    name: "Delete Group",
    icon: "<i class=\"fas fa-trash\"></i>",
    condition: li => game.user.isGM && !!li?.[0]?.closest(".combatant-group"), callback: async li => {
      const groupId = li?.[0]?.closest(".combatant-group")?.dataset?.groupKey;
      if (!groupId) return ui.notifications.warn("Could not determine group.");

      const ok = await Dialog.confirm({
        title: `Delete Group \"${groupId}\"`,
        content: `<p>Delete this group and unassign its members?</p>`
      });
      if (!ok) return;

      const combat = game.combat;
      // 1️⃣ Remove the group itself
      if (GMPERMISSIONS()) {
        await combat.unsetFlag(MODULE_ID, `groups.${groupId}`);
      }

      // 2️⃣ _Actually_ unassign each member from the group
      for (const c of combat.combatants.filter(c => c.getFlag(MODULE_ID, "groupId") === groupId)) {
        if (GMPERMISSIONS()) {
          await c.unsetFlag(MODULE_ID, "groupId");
        }
      }

      ui.combat.render();
    }
  };
}
