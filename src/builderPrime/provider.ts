import type { BuilderPrimeProject, ListProjectsParams } from "./types.js";

/**
 * What the services need from a source of projects. Both the live
 * BuilderPrimeClient and the sample-data provider satisfy this, so services
 * never care which one they're talking to.
 */
export interface ProjectProvider {
  listAllProjects(
    params?: Omit<ListProjectsParams, "page">
  ): Promise<BuilderPrimeProject[]>;
  /** True when results are synthetic (no live credentials configured). */
  readonly isSample: boolean;
}
