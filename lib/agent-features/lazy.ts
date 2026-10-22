import type { AgentFeature, AgentFeatureMetadata } from "./types.js";

/** Cache module code only. Catalog/help never calls the loader or caches user data. */
export function lazyAgentFeature(metadata: AgentFeatureMetadata, load: () => Promise<{ default: AgentFeature }>): AgentFeature {
  let module: Promise<AgentFeature> | undefined;
  const implementation = () => module ??= load().then(({ default: feature }) => {
    if (feature.id !== metadata.id || feature.help !== metadata.help) throw new Error(`Personal-agent metadata does not match ${metadata.id}.`);
    return feature;
  }).catch(error => { module = undefined; throw error; });
  return {
    ...metadata,
    async execute(command, context) {
      context.signal?.throwIfAborted();
      const feature = await implementation();
      context.signal?.throwIfAborted();
      return feature.execute(command, context);
    },
  };
}
