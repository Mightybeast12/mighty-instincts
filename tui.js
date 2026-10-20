/**
 * OpenCode 2 TUI companion for mighty-instincts.
 *
 * Mounts the sidebar board panel (sidebar.js) when the host offers slots.
 * That module imports the host's @opentui/solid and solid-js, so it is
 * loaded lazily and a failure there never breaks plugin setup.
 */
import { PKG_NAME } from "./lib/pkg.js";

const plugin = {
  id: PKG_NAME,
  async setup(ctx) {
    const disposeSidebar = await mountSidebar(ctx);
    return async () => {
      disposeSidebar?.();
    };
  },
};

async function mountSidebar(ctx) {
  if (ctx.options?.board?.enabled === false) return undefined;
  if (typeof ctx.ui?.slot !== "function") return undefined;
  try {
    const sidebar = await import("./sidebar.js");
    return sidebar.mountSidebar(ctx);
  } catch (error) {
    console.error(`[${PKG_NAME}] sidebar panel unavailable`, error);
    return undefined;
  }
}

export default plugin;
