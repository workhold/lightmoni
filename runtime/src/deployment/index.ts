export * from "./types.js";
export * from "./verification.js";
export { SystemdDeploymentAdapter, systemdDeploymentAdapter } from "./systemd.js";

import type { DeploymentAdapter } from "./types.js";
import { systemdDeploymentAdapter } from "./systemd.js";

/**
 * Central provider registry. New providers (for example docker_compose) can
 * be added without changing the service/deployment data model. Registration
 * is explicit so an unknown provider can never silently fall back to systemd.
 */
export class DeploymentAdapterRegistry {
  private readonly adapters = new Map<string, DeploymentAdapter>();

  constructor(initial: DeploymentAdapter[] = []) {
    for (const adapter of initial) this.register(adapter);
  }

  register(adapter: DeploymentAdapter): this {
    if (this.adapters.has(adapter.provider)) throw new Error(`deployment provider already registered: ${adapter.provider}`);
    this.adapters.set(adapter.provider, adapter);
    return this;
  }

  get(provider: string): DeploymentAdapter | undefined {
    return this.adapters.get(provider);
  }

  require(provider: string): DeploymentAdapter {
    const adapter = this.get(provider);
    if (!adapter) throw new Error(`unsupported deployment provider: ${provider}`);
    return adapter;
  }

  list(): string[] {
    return [...this.adapters.keys()].sort();
  }
}

export const deploymentAdapters = new DeploymentAdapterRegistry([systemdDeploymentAdapter]);
