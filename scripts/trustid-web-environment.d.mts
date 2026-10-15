export declare const WEB_ENVIRONMENTS: readonly ["production", "staging", "development"];
export declare function resolveWebEnvironment(
  env: Record<string, string | undefined>,
  mode: string,
): "production" | "staging" | "development";
