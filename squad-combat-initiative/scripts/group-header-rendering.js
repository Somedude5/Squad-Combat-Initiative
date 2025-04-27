/****************************************************************************************
 * group-header-rendering.js – injects custom, collapsible “group headers” into the
 * Combat Tracker so a GM can treat several combatants as a single block.
 *
 *  ⚙ Key features kept 100 % intact:
 *      • Hidden “Group Placeholder” NPC so headers can be drag‑dropped.
 *      • Monkey‑patch of CombatTracker.prototype.renderGroups.
 *      • Pin / reset / roll / delete buttons.
 *      • Inline initiative editing (dbl‑click) for GMs + Assistants.
 *      • Hover recolour of the roll icon based on Alt/Ctrl keys.
 *      • Collapse / expand handling with per‑group flags.
 *
 ****************************************************************************************/

import { MODULE_ID, log, expandStore, GMPERMISSIONS } from "./shared.js";
import { getPluralRules, formatNumber } from "./rolling-overrides.js";
import { GroupManager, GroupContextMenuManager } from "./class-objects.js";
import { attachContextMenu } from "./combat-tracker.js";


// Injects custom group header elements into the combat tracker.
export async function groupHeaderRendering() {
    /* ------------------------------------------------------------------
     * Create or locate a helper NPC (enables some token‑drag scenarios).
     * ------------------------------------------------------------------ */
    const ACTOR_NAME = "[Group Placeholder]";
    const actor = game.actors.find(
        a => a.name === ACTOR_NAME && a.getFlag(MODULE_ID, "isGroupHelper")
    );

    if (actor) {
        game.modules.get(MODULE_ID).groupHelperActor = actor;
    } else {
        Actor.create({
            name: ACTOR_NAME,
            type: "npc",
            img: "icons/svg/temple.svg",
            token: { name: ACTOR_NAME, img: "icons/svg/temple.svg", disposition: -1 },
            flags: { [MODULE_ID]: { isGroupHelper: true } }
        }).then(newActor => game.modules.get(MODULE_ID).groupHelperActor = newActor);
    }

    /* ------------------------------------------------------------------
     * Patch CombatTracker.render to add group header rendering.
     * ------------------------------------------------------------------ */
    const CT = ui.combat?.constructor;
    if (!CT) {
        console.warn(`[${MODULE_ID}] Could not locate CombatTracker class.`);
        return;
    }

    // ------------------------------------------------------------------
    //  Extend CombatTracker with renderGroups (called by renderCombatTracker).
    // ------------------------------------------------------------------
    CT.prototype.renderGroups = function (html) {
        log("renderGroups called");                         // obeys enableLogging setting

        const combat = this.viewed;
        if (!combat) return; // ⬅️ Bail early if no combat to avoid crash

        const expandedGroups = expandStore.load(combat.id);


        const flagGroups = foundry.utils.getProperty(combat, `flags.${MODULE_ID}.groups`) || {};
        const groups = GroupManager.getGroups(combat.turns, combat);  // Map<groupId, { name, members }>

        const V13 = game.release.generation >= 13;
        const list = html.querySelector(".directory-list, .combat-tracker");
        if (!list) return;

        /* Clear any group headers from a previous render pass. */
        list.querySelectorAll("li.combatant-group[data-group-key]").forEach(el => el.remove());

        /* --------------------------------------------------------------
         * Create new group headers and insert them into the tracker.
         * -------------------------------------------------------------- */
        for (const [groupId, groupData] of groups.entries()) {
            if (groupId === "ungrouped") continue;   // don’t render the default holder
            const groupCfg = flagGroups[groupId] || {};
            const initiativegroupName = groupCfg.name ?? groupData.name ?? "Unnamed Group";
            const canManage = game.user.isGM || game.user.role >= CONST.USER_ROLES.ASSISTANT;
            const combatants = groupData.members;
            const img = groupCfg.img || "icons/svg/combat.svg";
            const color = groupCfg.color || "#000000";
            const expanded = expandedGroups.has(groupId);

            // Prefer stored average initiative; fallback to recomputed rounded mean.
            // Only show initiative if ALL members have it
            let avgInit = null;

            if (combatants.length > 0) {
                const allHaveInitiative = combatants.every(c => Number.isFinite(c.initiative));
                if (allHaveInitiative && combatants.length > 0) {
                    avgInit = combat.getFlag(MODULE_ID, `groups.${groupId}`)?.initiative;

                    // Fallback to live calc if no group flag is present
                    if (!Number.isFinite(avgInit)) {
                        const vals = combatants.map(c => c.initiative);
                        avgInit = Math.round(vals.reduce((a, b) => a + b, 0) / vals.length);
                    }
                }
            }


            /* ----------------------------------------------------------
             *  Build DOM <li> for the header.
             * ---------------------------------------------------------- */
            const groupContainer = document.createElement("li");
            groupContainer.classList.add("combatant-group", "collapsible", "dnd5e2-collapsible");
            if (!V13) groupContainer.classList.add("directory-item");
            if (!expanded) groupContainer.classList.add("collapsed");
            groupContainer.dataset.groupKey = groupId;
            groupContainer.dataset.groupColor = color; // ✅ For reference/debug
            groupContainer.style.setProperty("--group-color", color); // ✅ Inject CSS var

            const count = game.i18n.format(
                `DND5E.COMBATANT.Counted.${getPluralRules().select(combatants.length)}`,
                { number: formatNumber(combatants.length) }
            );

            groupContainer.innerHTML = /*html*/`
            <div class="group-header grid-layout">
              <!-- [1] Icon -->
              <div class="header-img">
                <img class="token-image" src="${img}" title="Group icon for ${initiativegroupName}">
              </div>
              <!-- [2] Buttons bar (spans cols 2–3) -->
              ${canManage ? `
                <div class="header-buttons group-controls">
                  <a class="combat-button group-pin"    title="Pin Group"><i class="fas fa-thumbtack"></i></a>
                  <a class="combat-button group-reset"  title="Reset Initiative"><i class="fas fa-undo"></i></a>
                  <a class="combat-button group-roll"   title="Roll Initiative"><i class="fa-solid fa-dice-d20"></i></a>
                  <a class="combat-button group-delete" title="Delete Group"><i class="fa-solid fa-xmark"></i></a>
                </div>
                ` : ``}                
              <!-- [3] Name + count -->
              <div class="header-name token-name">
                <strong class="name">${initiativegroupName}</strong>
                <div class="group-numbers">${count}</div>
              </div>
              <!-- [4] Initiative -->
              <div class="header-init group-initiative-value">
                ${Number.isFinite(avgInit) ? formatNumber(avgInit) : ""}
              </div>
              <!-- [5] Collapse toggle (spans cols 2–3) -->
                <div class="collapse-toggle header-toggle">
                <i class="fa-solid fa-chevron-down"></i>
                </div>
            </div>
            <div class="collapsible-content">
              <div class="wrapper">
                <ol class="group-children ${V13 ? "" : "directory-list"}"></ol>
              </div>
            </div>
          `;



            /* ----------------------------------------------------------
             *  Move member <li> nodes under the new header.
             * ---------------------------------------------------------- */
            const selector = combatants.map(c => `[data-combatant-id="${c.id}"]`).join(", ");
            const children = selector ? Array.from(list.querySelectorAll(selector)) : [];

            const target = groupContainer.querySelector(".group-children");
            if (children.length) {
                children[0].before(groupContainer);
                target.replaceChildren(...children);
            } else {
                target.innerHTML = '<li class="no-members">No members</li>';
                list.insertBefore(groupContainer, list.firstChild);
            }

            /* ----------------------------------------------------------
             *  GM‑only interactive controls.
             * ---------------------------------------------------------- */
            if (game.user.isGM || game.user.role >= CONST.USER_ROLES.ASSISTANT) {
                /* ――― Initiative inline edit (dbl‑click) ――― */
                const initiativeDisplay = groupContainer.querySelector(".group-initiative-value");
                initiativeDisplay.addEventListener("dblclick", async event => {
                    event.stopPropagation();
                    const currentValue = parseFloat(initiativeDisplay.textContent.trim());
                    if (isNaN(currentValue)) return;

                    // Swap display for an <input>.
                    const input = document.createElement("input");
                    input.type = "number";
                    input.step = "any";
                    input.value = currentValue;
                    input.classList.add("group-initiative-edit");
                    initiativeDisplay.replaceWith(input);
                    input.focus();

                    const applyChange = async () => {
                        const newBase = parseFloat(input.value);
                        if (isNaN(newBase)) return ui.combat.render();   // cancel if invalid

                        // Preserve decimal tie‑break offsets when shifting base value.
                        const updates = groupData.members.map(c => ({
                            _id: c.id,
                            initiative: newBase + ((c.initiative ?? 0) - currentValue)
                        }));
                        if (GMPERMISSIONS()) {
                            await combat.updateEmbeddedDocuments("Combatant", updates);
                        }
                        if (GMPERMISSIONS()) {
                            await combat.setFlag(MODULE_ID, `groups.${groupId}.initiative`, newBase);
                        }
                        ui.combat.render();                               // re‑render tracker
                    };

                    input.addEventListener("blur", applyChange);
                    input.addEventListener("keydown", e => {
                        if (e.key === "Enter") input.blur();
                        if (e.key === "Escape") ui.combat.render();
                    });
                });
            }
            if (canManage) {
                /* ――― Pin toggle ――― */
                const pinBtn = groupContainer.querySelector(".group-pin");
                if (flagGroups[groupId]?.pinned) {
                    pinBtn.classList.add("pinned");
                    pinBtn.setAttribute("title", "Unpin Group");
                }
                pinBtn.addEventListener("click", async event => {
                    event.stopPropagation();
                    const newState = !(flagGroups[groupId]?.pinned ?? false);
                    if (GMPERMISSIONS()) {
                        await combat.setFlag(MODULE_ID, `groups.${groupId}.pinned`, newState);
                    }
                    pinBtn.classList.toggle("pinned", newState);
                    pinBtn.setAttribute("title", newState ? "Unpin Group" : "Pin Group");
                    ui.combat.render();
                });

                /* ――― Roll button ――― */
                const rollBtn = groupContainer.querySelector(".group-roll");
                bindGlobalRollHover(); // (NOT WORKING, the advantage/disadvantage buttons work for the roll but they dont change the color of the button when held 4/21/25)

                /* call into GroupManager */
                rollBtn.addEventListener("click", async event => {
                    event.stopPropagation();
                    const mode = event.altKey
                        ? "advantage"
                        : (event.ctrlKey || event.metaKey)
                            ? "disadvantage"
                            : "normal";

                    await GroupManager.rollGroupAndApplyInitiative(combat, groupId, { mode });
                });

                /* ――― Reset button ――― */
                groupContainer.querySelector(".group-reset")
                    ?.addEventListener("click", async event => {
                        event.stopPropagation();
                        const confirmed = await Dialog.confirm({
                            title: `Reset Initiative for "${initiativegroupName}"`,
                            content: "<p>Clear initiative for all members of this group?</p>"
                        });
                        if (!confirmed) return;

                        // 1. Clear initiative from all members
                        const updates = combatants.map(c => ({ _id: c.id, initiative: null }));
                        if (GMPERMISSIONS()) {
                            await combat.updateEmbeddedDocuments("Combatant", updates);
                        }

                        // 2. Clear group initiative flag
                        if (GMPERMISSIONS()) {
                            await combat.unsetFlag(MODULE_ID, `groups.${groupId}.initiative`);
                        }

                        ui.notifications.info(`Initiative cleared for group "${initiativegroupName}".`);
                        ui.combat.render();
                    });

                /* ――― Delete button ――― */
                groupContainer.querySelector(".group-delete")
                    ?.addEventListener("click", async event => {
                        event.stopPropagation();
                        const confirmed = await Dialog.confirm({
                            title: `Delete Group "${initiativegroupName}"`,
                            content: "<p>Delete this group and unassign its members?</p>"
                        });
                        if (!confirmed) return;
                        if (GMPERMISSIONS()) {
                            await combat.unsetFlag(MODULE_ID, `groups.${groupId}`);
                        }
                        if (GMPERMISSIONS()) {
                            for (const c of combatants) await c.unsetFlag(MODULE_ID, "groupId");
                        }
                        ui.combat.render();
                    });
            }

            /* Collapse/expand on header click (but not on controls) */
            groupContainer.addEventListener("click", event => {
                const insideControls =
                    event.target.closest(".group-controls") ||
                    event.target.closest(".group-initiative-value") ||
                    event.target.closest(".group-initiative-edit");
                if (insideControls || event.target.closest(".collapsible-content")) return;

                const collapsed = groupContainer.classList.toggle("collapsed");

                /* ① let CSS animate … */
                const delay = 310;   // 10 ms longer than the 300 ms CSS
                setTimeout(() => {
                    if (collapsed) expandedGroups.delete(groupId);
                    else expandedGroups.add(groupId);
                    expandStore.save(combat.id, expandedGroups);
                }, 310);        // 10 ms longer than the 300 ms CSS transition
            });

        }
        if (game.user.role === CONST.USER_ROLES.GAMEMASTER) {
            attachContextMenu($(list));
        }
    };

    log(`✅ ${MODULE_ID} | renderGroups injected and ${CT.name}.render patched.`);
}

// Function for the roll button to change color to green if holding alt for advantage or red for disadvantage for funsies
function bindGlobalRollHover() {
    if (bindGlobalRollHover.bound) return;
    bindGlobalRollHover.bound = true;

    let hoveredBtn = null;

    /** Apply color to the icon */
    function updateIconColor(altKey, ctrlKey) {
        if (!hoveredBtn) return;
        const icon = hoveredBtn.querySelector("i");
        if (!icon) return;
        if (altKey && !ctrlKey) icon.style.color = "limegreen";
        else if (ctrlKey && !altKey) icon.style.color = "darkred";
        else icon.style.color = "";
    }

    // When my pointer enters a roll-button, remember it and paint it immediately
    document.addEventListener("pointerenter", ev => {
        const btn = ev.target.closest?.(".group-roll");
        if (!btn) return;
        hoveredBtn = btn;
        updateIconColor(ev.altKey, ev.ctrlKey);
    }, true);

    // When my pointer leaves, clear that icon
    document.addEventListener("pointerleave", ev => {
        const btn = ev.target.closest?.(".group-roll");
        if (!btn || btn !== hoveredBtn) return;
        const icon = btn.querySelector("i");
        if (icon) icon.style.color = "";
        hoveredBtn = null;
    }, true);

    // On any keydown/up, repaint the hovered button (if any)
    document.addEventListener("keydown", ev => updateIconColor(ev.altKey, ev.ctrlKey));
    document.addEventListener("keyup", ev => updateIconColor(ev.altKey, ev.ctrlKey));
}

