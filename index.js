import { Plugin } from "@opencode/plugin";
import { setup } from "./lib/plugin.js";
import { PKG_NAME } from "./lib/pkg.js";

export default Plugin.define({ id: PKG_NAME, setup });
