import { Plugin } from "@opencode/plugin";
import { createRuntime } from "./runtime.ts";
import { registerHooks } from "./hooks.ts";
import { registerSkill } from "./skill.ts";
import { registerTools } from "./tools.ts";

export default Plugin.define({
  id: "goldfish.project-memory",
  async setup(ctx) {
    const runtime = await createRuntime(ctx);
    const tools = await registerTools(ctx, runtime);
    const cleanupHooks = await registerHooks(ctx, runtime);
    const skill = await registerSkill(ctx);
    return async () => {
      await cleanupHooks();
      await skill.dispose();
      await tools.dispose();
      runtime.store.close();
    };
  },
});
