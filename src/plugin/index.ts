import { Plugin } from "@opencode/plugin";
import { createRuntime } from "./runtime.ts";
import { registerCommands } from "./commands.ts";
import { registerHooks } from "./hooks.ts";
import { registerSkills } from "./skill.ts";
import { registerTools } from "./tools.ts";

export default Plugin.define({
  id: "goldfish.project-memory",
  async setup(ctx) {
    const runtime = await createRuntime(ctx);
    const tools = await registerTools(ctx, runtime);
    const cleanupHooks = await registerHooks(ctx, runtime);
    const skills = await registerSkills(ctx);
    const commands = await registerCommands(ctx);
    return async () => {
      await cleanupHooks();
      await commands.dispose();
      await skills.dispose();
      await tools.dispose();
      runtime.store.close();
    };
  },
});
