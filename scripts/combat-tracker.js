/****************************************************************************************
 * combat‑tracker.js — render‑time helpers for group headers, drag‑and‑drop and hooks
 * --------------------------------------------------------------------------------------
 * Public exports (hook callbacks):
 *   • combatTrackerRendering(app, html)      — renderCombatTracker
 *   • onDeleteCombat(combat)                 — deleteCombat
 *   • onCreateCombatant(combatant)           — createCombatant
 *   • onUpdateCombat(combat, updateData)     — updateCombat
 ****************************************************************************************/

import { MODULE_ID, log, generateGroupId, expandStore, GMPERMISSIONS } from "./shared.js";
import { GroupManager, GroupContextMenuManager } from "./class-objects.js";
import { wrapped } from "./rolling-overrides.js";

const SELECTORS = {
    list: "ol.directory-list, .combat-tracker",
    group: ".combatant-group",
    groupHead: ".combatant-group > .group-header"
};

/* ------------------------------------------------------------------ */
/*  RENDER‑TIME ENHANCEMENTS                                          */
/* ------------------------------------------------------------------ */
export function combatTrackerRendering(_app, html) {
    if (!game.user.isGM) return;                    // Only GMs manage groups

    ensureAddGroupButton(html);
    const combat = game.combat;
    if (!combat) return;                            // Nothing to do otherwise

    enableTokenDrag(combat, html);
    registerDropTargets(combat, html);
}

/* ---------- helpers ---------- */

/** Injects a single “Add Group” button above the tracker controls. */
function ensureAddGroupButton(html) {
    if (html.find(".create-group-button").length) return;

    const $btn = $(`<button type="button" class="create-group-button">➕ Add Group</button>`);
    html.find("#combat-controls").prepend($btn);
    $btn.on("click", openCreateGroupDialog);
}

/** Marks combatant <li> nodes draggable once per render. */
function enableTokenDrag(combat, html) {
    html.find("li.combatant").each((_, li) => {
        const id = li.dataset.combatantId;
        if (!combat.combatants.get(id)?.actor) return;

        li.draggable = true;
        li.addEventListener("dragstart", ev =>
            ev.dataTransfer?.setData("text/plain", id), { once: true });
    });
}

/** Sets up drop behaviour for grouping / un‑grouping combatants. */
function registerDropTargets(combat, html) {
    const $list = html.find(SELECTORS.list);

    /* Assign to a header */
    $list
        .off(".groupAssign")
        .on("dragover.groupAssign", SELECTORS.group, ev => {
            ev.preventDefault();
            ev.originalEvent.dataTransfer.dropEffect = "move";
        })

        .on("drop.groupAssign", SELECTORS.group, async ev => {
            ev.preventDefault();

            const groupId = $(ev.currentTarget).data("groupKey");
            const combat = game.combat;
            const combatantId = ev.originalEvent.dataTransfer.getData("text/plain");
            const combatant = combat.combatants.get(combatantId);
            if (!combatant?.actor) return;
            if (GMPERMISSIONS()) {
                await combatant.setFlag(MODULE_ID, "groupId", groupId);
            }
            const group = await combat.getFlag(MODULE_ID, `groups.${groupId}`);
            if (group && Number.isFinite(group.initiative)) {
                const base = group.initiative;

                const existing = combat.combatants.filter(c =>
                    c.getFlag(MODULE_ID, "groupId") === groupId &&
                    c.id !== combatant.id &&
                    Number.isFinite(c.initiative)
                );

                // Re-stagger existing group members: highest to lowest
                const sorted = existing.slice().sort((a, b) => b.initiative - a.initiative);
                const updates = sorted.map((c, i) => ({
                    _id: c.id,
                    initiative: parseFloat((base + 0.01 + (sorted.length - i) * 0.01).toFixed(2))
                }));

                if (GMPERMISSIONS()) {
                    await combat.updateEmbeddedDocuments("Combatant", updates);
                }


                // Add new token at lowest initiative (base + 0.01)
                const maxSort = Math.max(...existing.map(c => c.sort ?? 0), 0);

                combatant._skipFinalize = true;
                await combatant.update({
                    initiative: parseFloat((base + 0.01).toFixed(2)),
                    sort: maxSort + 100
                });
                delete combatant._skipFinalize;
            }
            ui.combat.render();
        });

    /* Drop elsewhere → unassign */
    $list
        .off("drop.groupRemove")
        .on("drop.groupRemove", async ev => {
            if ($(ev.target).closest(SELECTORS.group).length) return;
            ev.preventDefault();
            const combatantId = ev.originalEvent.dataTransfer.getData("text/plain");
            const c = combat.combatants.get(combatantId);
            const oldGroup = c?.getFlag(MODULE_ID, "groupId");

            if (c?.actor && oldGroup) {
                // 1. Unassign from group
                if (GMPERMISSIONS()) {
                    await c.unsetFlag(MODULE_ID, "groupId");
                }
                // 2. Check if that was the last member
                const remaining = combat.combatants.filter(
                    x => x.getFlag(MODULE_ID, "groupId") === oldGroup
                );

                if (remaining.length === 0) {
                    if (GMPERMISSIONS()) {
                        await combat.unsetFlag(MODULE_ID, `groups.${oldGroup}.initiative`);
                    }
                }

                ui.combat.render();
            }
        });
}

/** Adds context‑menu to group headers (GM + assistants). */
export function attachContextMenu($list) {

    if (!game.user.isGM && game.user.role < CONST.USER_ROLES.ASSISTANT) {
        return; // ⛔ prevent menu for players
    }

    if (!$list?.length || typeof ContextMenu !== "function") {
        console.warn("[GroupSort] No valid list found for ContextMenu attachment.");
        return;
    }

    new ContextMenu(
        $list[0],
        SELECTORS.groupHead,
        GroupContextMenuManager.getContextOptions()
    );
}

/* ------------------------------------------------------------------ */
/*  CREATE GROUP DIALOG                                               */
/* ------------------------------------------------------------------ */

async function openCreateGroupDialog() {
    const data = await promptGroupData();
    if (!data?.name) return;

    /* Ensure combat encounter exists. */
    let combat = game.combat;
    if (!combat) {
        combat = await game.combats.documentClass.create({ scene: canvas.scene.id });
        await combat.activate();
    }

    /* Prevent duplicate names. */
    // const groups = combat.getFlag(MODULE_ID, "groups") ?? {};
    // const duplicate = Object.values(groups).find(g => g.name === data.name);
    // if (duplicate) return ui.notifications.warn(`A group named “${data.name}” already exists.`);


    /* Compute baseline initiative & sort. */
    const maxInit = Math.max(0, ...combat.turns.map(t => t.initiative ?? 0));
    const maxSort = Math.max(0, ...combat.combatants.map(c => c.sort ?? 0));

    const groupId = generateGroupId();
    if (GMPERMISSIONS()) {
        await combat.setFlag(MODULE_ID, `groups.${groupId}`, {
            name: data.name,
            initiative: null,
            expanded: true,
            img: data.img || "icons/svg/combat.svg",
            color: data.color || "#00ff00",
        });
        const expandedSet = expandStore.load(combat.id);
        expandedSet.add(groupId);
        expandStore.save(combat.id, expandedSet);
    }

    /* Add selected tokens (if missing) and flag them. */
    const sel = canvas.tokens.controlled;
    const missing = sel.filter(t => !combat.combatants.some(c => c.tokenId === t.id));
    if (missing.length) {
        const docs = missing.map((t, i) => ({
            tokenId: t.id,
            actorId: t.actor?.id,
            sceneId: canvas.scene.id,
            sort: maxSort + (i + 1) * 100,
        }));
        await combat.createEmbeddedDocuments("Combatant", docs);
        await combat.reset();
    }
    const members = sel
        .map(t => combat.combatants.find(c => c.tokenId === t.id))
        .filter(Boolean);

    for (const c of members) {
        if (GMPERMISSIONS()) {
            await c.setFlag(MODULE_ID, "groupId", groupId);
        }
    }

    ui.notifications.info(`Created group “${data.name}” with ${members.length} member(s).`);
    ui.combat.render();
}

/** Small dialog → returns {name,img,color} or null. */
function promptGroupData() {
    return new Promise(res => {
        new Dialog({
            title: "Create New Group",
            content: `
        <p>Name:</p>
        <input id="g-name"  type="text" style="width:100%" value="New Group">
        <p style="margin-top:.75em;">Icon:</p>
        <div class="form-group">
          <input id="g-img" type="text" style="width:80%" placeholder="icons/svg/skull.svg">
          <button type="button" id="g-img-picker" style="width:18%;margin-left:2%">📁</button>
        </div>
        <p style="margin-top:.75em;">Color:</p>
        <input id="g-color" type="color" style="width:100%">
      `,
            buttons: {
                ok: {
                    label: "Create",
                    callback: html => res({
                        name: html.find("#g-name").val().trim(),
                        img: html.find("#g-img").val().trim(),
                        color: html.find("#g-color").val().trim()
                    })
                },
                cancel: { label: "Cancel", callback: () => res(null) }
            },
            default: "ok",
        }).render(true);

        Hooks.once("renderDialog", (_app, $html) =>
            $html.find("#g-img-picker").on("click", () =>
                new FilePicker({
                    type: "image",
                    current: "icons/",
                    callback: path => $html.find("#g-img").val(path)
                }).render(true)
            )
        );
    });
}

/* ------------------------------------------------------------------ */
/*  OTHER HOOK CALLBACKS                                              */
/* ------------------------------------------------------------------ */

/** Clean up libWrapper hooks when a combat encounter is deleted. */

export function onDeleteCombat() {
    // Only try to unregister if lib-wrapper is active, AND
    // we actually registered our wrappers in overrideRollMethods()
    if (!game.modules.get("lib-wrapper")?.active || !wrapped) return;

    try {
        libWrapper.unregister(MODULE_ID, "Combat.prototype.rollAll");
    } catch {
        /* nothing to do if it wasn’t registered */
    }
    try {
        libWrapper.unregister(MODULE_ID, "Combat.prototype.rollNPC");
    } catch {
        /* nothing to do if it wasn’t registered */
    }
}

/** Ensure every new combatant has at least the “Ungrouped” flag. */
export async function onCreateCombatant(combatant) {
    if (game.user.isGM && !combatant.getFlag(MODULE_ID, "groupId")) {
        if (GMPERMISSIONS()) {
            await combatant.setFlag(MODULE_ID, "groupId", "ungrouped");
        }
    }
}

/** Auto-collapse groups on turn change (per-client, respects pins + animation). */
export async function onUpdateCombat(combat, update) {
    if (!("turn" in update) ||
        !game.settings.get(MODULE_ID, "autoCollapseGroups")) return;

    const activeGroup = combat.combatant?.getFlag(MODULE_ID, "groupId");
    const flagGroups = foundry.utils.getProperty(combat, `flags.${MODULE_ID}.groups`) || {};
    const manualPins = foundry.utils.getProperty(combat, `flags.${MODULE_ID}.groupManualOverrides`) || {};

    log(`[${MODULE_ID}] onUpdateCombat triggered. Active group:`, activeGroup);

    const expandedSet = expandStore.load(combat.id);

    for (const [gid, cfg] of Object.entries(flagGroups)) {
        if (manualPins[gid]) continue;
        const shouldExpand = cfg.pinned || gid === activeGroup;
        if (shouldExpand) expandedSet.add(gid);
        else expandedSet.delete(gid);
    }

    log(`[${MODULE_ID}] Updated expandedSet:`, [...expandedSet]);

    expandStore.save(combat.id, expandedSet);

    // Force re-render
    log(`[${MODULE_ID}] Calling ui.combat.render()...`);
    ui.combat.render();

    // After paint
    Hooks.once("renderCombatTracker", (_app, html) => {
        log(`[${MODULE_ID}] renderCombatTracker hook fired.`);

        requestAnimationFrame(() => {
            const list = html[0].querySelector(".directory-list, .combat-tracker");
            if (!list) {
                console.warn(`[${MODULE_ID}] No tracker list found.`);
                return;
            }

            const groups = list.querySelectorAll("li.combatant-group[data-group-key]");
            log(`[${MODULE_ID}] Found ${groups.length} group headers.`);

            for (const li of groups) {
                const gid = li.dataset.groupKey;
                const shouldBeOpen = expandedSet.has(gid);

                log(`[${MODULE_ID}] Group ${gid}: before classList =`, [...li.classList]);

                li.classList.toggle("collapsed", !shouldBeOpen);

                log(`[${MODULE_ID}] Group ${gid}: after classList =`, [...li.classList]);
            }
        });
    });
}


