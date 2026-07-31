import { cleanClassName, toMs, type RawGrid } from "./pipeline.js";
import { PipelineFormatError } from "./pipeline.js";

/**
 * Parser + follow-up tracking for the Builder Prime "Unpaid Invoices" export.
 *
 * Friday meeting §1: every past-due balance needs a reason and an owner. Items
 * carry over week to week until resolved — a carried-over item demands an
 * update from its owner at the next meeting. Follow-ups are keyed by invoice
 * number so a fresh upload refreshes the numbers without losing the notes.
 */

export interface PastDueInvoice {
  invoiceNumber: string;
  client: string;
  projectName: string | null;
  projectStatus: string | null;
  amount: number | null;
  balance: number | null;
  className: string;
  dueDate: number | null;
  /** Days past due, when the export provides it. */
  age: number | null;
}

export interface FollowUpUpdate {
  /** Meeting week (weekStart ISO) the update was given in. */
  week: string;
  note: string;
  by: string | null;
  at: string;
}

export interface FollowUp {
  invoiceNumber: string;
  client: string;
  projectName: string | null;
  projectStatus: string | null;
  balance: number | null;
  className: string;
  dueDate: number | null;
  age: number | null;
  /** Why the balance is past due — filled in at the meeting. */
  reason: string;
  /** Who owns getting it collected/completed. */
  owner: string;
  /** Owner's email — used to invite them on the calendar event. */
  ownerEmail: string;
  /** Action/install date assigned to the owner (goes on their calendar). */
  actionDate: string | null;
  status: "open" | "resolved";
  /** Meeting week the invoice first showed up in. */
  firstSeenWeek: string;
  resolvedWeek: string | null;
  /** False when the latest upload no longer contains this invoice. */
  inLatestExport: boolean;
  updates: FollowUpUpdate[];
  updatedAt: string;
}

const HEADERS: Record<string, string[]> = {
  client: ["client", "customer", "customer name"],
  invoice: ["inv #", "inv#", "invoice #", "invoice", "invoice number"],
  projectName: ["project name", "project"],
  projectStatus: ["project status", "status"],
  amount: ["amount"],
  balance: ["balance"],
  className: ["class"],
  dueDate: ["due date"],
  age: ["age"],
};

function text(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s === "" ? null : s;
}

/** Parse "$20,240.15" / "(1,200)" / plain numbers to a number. */
export function parseMoney(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  const s = String(v).trim();
  const negative = /^\(.*\)$/.test(s);
  const n = Number(s.replace(/[^0-9.\-]/g, ""));
  if (!Number.isFinite(n)) return null;
  return negative ? -Math.abs(n) : n;
}

export interface PastDueParseResult {
  invoices: PastDueInvoice[];
  sourceLabel: string | null;
}

export function parseUnpaidInvoices(grid: RawGrid): PastDueParseResult {
  if (!Array.isArray(grid)) {
    throw new PipelineFormatError("Unpaid-invoice data must be a grid of rows.");
  }

  let headerRow = -1;
  const col: Record<string, number> = {};
  for (let r = 0; r < Math.min(grid.length, 10); r++) {
    const lower = (grid[r] ?? []).map((c) => text(c)?.toLowerCase() ?? "");
    if (
      lower.some((c) => HEADERS.invoice!.includes(c)) &&
      lower.some((c) => HEADERS.balance!.includes(c))
    ) {
      headerRow = r;
      for (const [key, names] of Object.entries(HEADERS)) {
        col[key] = lower.findIndex((c) => names.includes(c));
      }
      break;
    }
  }
  if (headerRow < 0) {
    throw new PipelineFormatError(
      "Couldn't find the unpaid-invoices header row (expected 'Inv #' and " +
        "'Balance' columns). Make sure you uploaded the Unpaid Invoices export."
    );
  }

  let sourceLabel: string | null = null;
  for (let r = 0; r < headerRow; r++) {
    for (const c of grid[r] ?? []) {
      const t = text(c);
      if (t && /\bas of\b/i.test(t)) sourceLabel = t;
    }
  }

  const cell = (row: unknown[], key: string) =>
    col[key]! >= 0 ? row[col[key]!] : undefined;

  const invoices: PastDueInvoice[] = [];
  for (let r = headerRow + 1; r < grid.length; r++) {
    const row = grid[r] ?? [];
    const invoice = text(cell(row, "invoice"));
    if (!invoice) continue;
    invoices.push({
      invoiceNumber: invoice,
      client: text(cell(row, "client")) ?? "—",
      projectName: text(cell(row, "projectName")),
      projectStatus: text(cell(row, "projectStatus")),
      amount: parseMoney(cell(row, "amount")),
      balance: parseMoney(cell(row, "balance")),
      className: cleanClassName(text(cell(row, "className"))),
      dueDate: toMs(cell(row, "dueDate")) ?? null,
      age: parseMoney(cell(row, "age")),
    });
  }
  return { invoices, sourceLabel };
}

export interface SyncResult {
  followUps: Record<string, FollowUp>;
  newCount: number;
  refreshedCount: number;
  /** Open follow-ups that disappeared from the export (likely paid). */
  missingCount: number;
}

/**
 * Merge a fresh unpaid-invoices upload into the follow-up collection.
 * Snapshot fields (balance, status, age…) refresh; meeting fields (reason,
 * owner, updates) persist. Open items missing from the new export are flagged
 * so the meeting can confirm them resolved with one tap.
 */
export function syncFollowUps(
  existing: Record<string, FollowUp>,
  invoices: PastDueInvoice[],
  meetingWeek: string,
  nowIso: string
): SyncResult {
  const followUps: Record<string, FollowUp> = { ...existing };
  const seen = new Set<string>();
  let newCount = 0;
  let refreshedCount = 0;

  for (const inv of invoices) {
    seen.add(inv.invoiceNumber);
    const prior = followUps[inv.invoiceNumber];
    if (prior) {
      const reappeared = prior.status === "resolved" && prior.resolvedWeek !== null &&
        prior.resolvedWeek < meetingWeek;
      followUps[inv.invoiceNumber] = {
        ...prior,
        client: inv.client,
        projectName: inv.projectName ?? prior.projectName,
        projectStatus: inv.projectStatus ?? prior.projectStatus,
        balance: inv.balance,
        className: inv.className,
        dueDate: inv.dueDate,
        age: inv.age,
        inLatestExport: true,
        status: reappeared ? "open" : prior.status,
        resolvedWeek: reappeared ? null : prior.resolvedWeek,
        updates: reappeared
          ? [
              ...prior.updates,
              {
                week: meetingWeek,
                note: "Re-opened: invoice showed up unpaid again in the latest export.",
                by: null,
                at: nowIso,
              },
            ]
          : prior.updates,
        updatedAt: nowIso,
      };
      refreshedCount++;
    } else {
      followUps[inv.invoiceNumber] = {
        invoiceNumber: inv.invoiceNumber,
        client: inv.client,
        projectName: inv.projectName,
        projectStatus: inv.projectStatus,
        balance: inv.balance,
        className: inv.className,
        dueDate: inv.dueDate,
        age: inv.age,
        reason: "",
        owner: "",
        ownerEmail: "",
        actionDate: null,
        status: "open",
        firstSeenWeek: meetingWeek,
        resolvedWeek: null,
        inLatestExport: true,
        updates: [],
        updatedAt: nowIso,
      };
      newCount++;
    }
  }

  let missingCount = 0;
  for (const fu of Object.values(followUps)) {
    if (!seen.has(fu.invoiceNumber)) {
      fu.inLatestExport = false;
      if (fu.status === "open") missingCount++;
    }
  }

  return { followUps, newCount, refreshedCount, missingCount };
}
