import type {
  BuilderPrimeErrorBody,
  BuilderPrimeProject,
  ListProjectsParams,
} from "./types.js";

const MAX_LIMIT = 100;

/**
 * Error thrown when Builder Prime returns a failure. The `userMessage` is safe
 * to surface to a production manager; the raw API error is never shown (§7.5).
 */
export class BuilderPrimeError extends Error {
  readonly code: string;
  readonly status: number;
  readonly userMessage: string;

  constructor(code: string, message: string, status: number) {
    super(message);
    this.name = "BuilderPrimeError";
    this.code = code;
    this.status = status;
    this.userMessage =
      code === "API_UNAUTHORIZED"
        ? "We couldn't connect to Builder Prime. Please contact your administrator to check the integration key."
        : "Builder Prime is temporarily unavailable. Your manual entries are safe — please try again shortly.";
  }
}

type FetchFn = typeof fetch;

export interface BuilderPrimeClientOptions {
  subdomain: string;
  apiKey: string;
  fetchFn?: FetchFn;
}

function isErrorBody(value: unknown): value is BuilderPrimeErrorBody {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { success?: unknown }).success === false &&
    Array.isArray((value as { errors?: unknown }).errors)
  );
}

export class BuilderPrimeClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly fetchFn: FetchFn;

  constructor(options: BuilderPrimeClientOptions) {
    this.baseUrl = `https://${options.subdomain}.builderprime.com/api`;
    this.apiKey = options.apiKey;
    this.fetchFn = options.fetchFn ?? fetch;
  }

  /** Fetch a single page of projects. */
  async listProjectsPage(
    params: ListProjectsParams = {}
  ): Promise<BuilderPrimeProject[]> {
    const url = new URL(`${this.baseUrl}/projects/v1`);
    if (params.opportunityId)
      url.searchParams.set("opportunity-id", params.opportunityId);
    if (params.lastModifiedSince !== undefined)
      url.searchParams.set(
        "last-modified-since",
        String(params.lastModifiedSince)
      );
    if (params.projectStatus)
      url.searchParams.set("project-status", params.projectStatus);
    url.searchParams.set(
      "limit",
      String(Math.min(params.limit ?? MAX_LIMIT, MAX_LIMIT))
    );
    url.searchParams.set("page", String(params.page ?? 0));

    let response: Response;
    try {
      response = await this.fetchFn(url.toString(), {
        headers: { "x-api-key": this.apiKey, Accept: "application/json" },
      });
    } catch (cause) {
      throw new BuilderPrimeError(
        "NETWORK_ERROR",
        `Network error contacting Builder Prime: ${String(cause)}`,
        503
      );
    }

    const text = await response.text();
    let body: unknown = undefined;
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = undefined;
      }
    }

    if (!response.ok || isErrorBody(body)) {
      const firstError = isErrorBody(body) ? body.errors[0] : undefined;
      throw new BuilderPrimeError(
        firstError?.code ?? `HTTP_${response.status}`,
        firstError?.message ?? `Builder Prime returned ${response.status}`,
        response.status
      );
    }

    // The API may return a bare array or wrap records in an envelope.
    if (Array.isArray(body)) return body as BuilderPrimeProject[];
    if (body && typeof body === "object") {
      const records =
        (body as { data?: unknown }).data ??
        (body as { projects?: unknown }).projects ??
        (body as { results?: unknown }).results;
      if (Array.isArray(records)) return records as BuilderPrimeProject[];
    }
    return [];
  }

  /**
   * Fetch every project matching the filter, following pagination until a
   * short page is returned. `maxPages` guards against runaway loops.
   */
  async listAllProjects(
    params: Omit<ListProjectsParams, "page"> = {},
    maxPages = 50
  ): Promise<BuilderPrimeProject[]> {
    const limit = Math.min(params.limit ?? MAX_LIMIT, MAX_LIMIT);
    const all: BuilderPrimeProject[] = [];
    for (let page = 0; page < maxPages; page++) {
      const batch = await this.listProjectsPage({ ...params, limit, page });
      all.push(...batch);
      if (batch.length < limit) break;
    }
    return all;
  }
}
