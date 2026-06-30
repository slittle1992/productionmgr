import type { ProjectProvider } from "./provider.js";
import type { BuilderPrimeProject } from "./types.js";
import type { PipelineStore } from "../storage/pipelineStore.js";

export type DataSourceKind = "pipeline" | "sample";

/**
 * Project source used when there are no live Builder Prime credentials: serves
 * the manager's uploaded pipeline when one exists, otherwise the sample data so
 * the app is never empty. `isSample` reflects the most recent fetch so the UI
 * banner is accurate.
 */
export class PipelineProvider implements ProjectProvider {
  private lastSource: DataSourceKind = "sample";

  constructor(
    private readonly store: PipelineStore,
    private readonly fallback: ProjectProvider
  ) {}

  get isSample(): boolean {
    return this.lastSource === "sample";
  }

  async listAllProjects(): Promise<BuilderPrimeProject[]> {
    const pipeline = await this.store.get();
    if (pipeline && pipeline.projects.length > 0) {
      this.lastSource = "pipeline";
      return pipeline.projects;
    }
    this.lastSource = "sample";
    return this.fallback.listAllProjects();
  }
}
