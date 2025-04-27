import { MODULE_ID, log } from "./shared.js";
// Default settings for the module. We removed the redundant settings for group roll and turn skipping,
// so only options that still affect behavior remain.
const DEFAULT_SETTINGS = {
    useRolledInit: false, // Apply the user's rolled initiative to new combatants in a group.
    enableLogging: false, // Toggle detailed debug logging for troubleshooting.
};

// Register only the necessary settings on the init hook.
export function registerSettings() {
    
    // game.settings.register(MODULE_ID, "", {
    //     name: "",
    //     hint: "",
    //     scope: "",
    //     config: true,
    //     type: Boolean,
    //     default: false,
    // });

    game.settings.register(MODULE_ID, "autoCollapseGroups", {
        name: "Auto Collapse Groups",
        hint: "When enabled, the active combatant's group will automatically expand on their turn.",
        scope: "world",
        config: true,
        type: Boolean,
        default: true,
    });

    game.settings.register(MODULE_ID, "enableLogging", {
        name: "Enable Debug Logging",
        hint: "Toggle debug logging for troubleshooting this module.",
        scope: "world",
        config: true,
        type: Boolean,
        default: false,
    });

    log("Module settings registered");
    log("Module initialization complete.");
}