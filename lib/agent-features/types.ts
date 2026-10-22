/** Shared contract for private, explicitly invoked personal-agent features. */
export type AgentContextKind =
  | "note" | "goal" | "habit" | "journal" | "bookmark" | "follow-up"
  | "reminder" | "monitor" | "digest" | "artifact" | "memory" | "event";

export type AgentContextItem = {
  /** Stable source identifier; output should cite this or sourceUrl. */
  id: string;
  kind: AgentContextKind;
  title: string;
  text: string;
  updatedAt?: string;
  dueAt?: string;
  status?: string;
  sourceUrl?: string;
  metadata?: Record<string, unknown>;
};

export type AgentSearchResult = {
  title: string;
  url: string;
  text: string;
  publishedAt?: string;
};

/** Runtime supplies a namespace scoped to workspace, user, and feature. */
export interface AgentFeatureStore {
  read<T>(key: string): Promise<T | null>;
  /** Pure synchronous transform; may run repeatedly after concurrent changes. */
  update<T, R>(
    key: string,
    initial: T,
    transform: (current: T) => { value: T; result: R },
  ): Promise<R>;
}

export interface AgentFeatureServices {
  /** Text-only inference. No tools, sending, scheduling, or other side effects. */
  generate(input: { instructions: string; input: string }): Promise<string>;
  /** Existing configured search provider; bounded public-web results. */
  search(query: string, limit?: number): Promise<AgentSearchResult[]>;
  /** Only caller-owned context allowed by the runtime; never arbitrary channels. */
  readContext(kinds?: AgentContextKind[]): Promise<AgentContextItem[]>;
}

export interface AgentFeatureContext {
  teamId: string;
  userId: string;
  channelId?: string;
  requestId?: string;
  now: Date;
  timezone: string;
  signal?: AbortSignal;
  store: AgentFeatureStore;
  services: AgentFeatureServices;
}

export interface AgentFeature {
  id: string;
  title: string;
  description: string;
  /** Command syntax and at least one realistic example. */
  help: string;
  execute(command: string, context: AgentFeatureContext): Promise<string>;
}
