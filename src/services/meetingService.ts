import type { ProjectProvider } from "../builderPrime/provider.js";
import type { AppConfig } from "../config.js";
import type { FollowUp } from "../domain/pastDue.js";
import { parseUnpaidInvoices, syncFollowUps } from "../domain/pastDue.js";
import { parseCompletedProjects } from "../domain/completedProjects.js";
import {
  buildLaborRates,
  buildPipelineChecks,
  buildWorkOrderReview,
  SECTION_KEYS,
  type CheckKey,
  type LaborRateRow,
  type ManualCheck,
  type MeetingWeekDoc,
  type PipelineChecks,
  type SectionKey,
  type SectionState,
  type WoNote,
  type WorkOrderReview,
} from "../domain/meeting.js";
import type { RawGrid } from "../domain/pipeline.js";
import { getReportingWeek, getReportingWeekFromStart, type ReportingWeek } from "../domain/week.js";
import type { MeetingStore, StoredUploadMeta } from "../storage/meetingStore.js";
import type { WorkOrderStore } from "../storage/workOrderStore.js";
import type { PayrollSheet } from "../domain/payroll.js";
import { summarisePayrollWorkbook } from "../domain/payroll.js";

/**
 * Orchestrates the Friday Production Meeting view: every numbered agenda item
 * assembled per week, with follow-ups that carry over until they're closed.
 */

export interface FollowUpView extends FollowUp {
  /** Open item first seen in an earlier week — owner owes an update. */
  carriedOver: boolean;
  /** Has an update note recorded for the requested meeting week. */
  updatedThisWeek: boolean;
}

export interface PastDueClassGroup {
  className: string;
  totalBalance: number;
  items: FollowUpView[];
}

export interface PastDueSection {
  meta: StoredUploadMeta | null;
  classes: PastDueClassGroup[];
  /** Open items missing from the latest export — probably paid; confirm. */
  likelyResolved: FollowUpView[];
  openCount: number;
  carryoverCount: number;
  needsInfoCount: number;
}

export interface SectionProgress {
  key: SectionKey;
  /** Computed from the data (uploads present, fields filled, checks done). */
  autoDone: boolean;
  /** Manual sign-off recorded at the meeting. */
  manual: SectionState | null;
  done: boolean;
}

export interface MeetingView {
  week: Pick<ReportingWeek, "weekStart" | "weekEnd" | "quarter">;
  pastDue: PastDueSection;
  workOrders: WorkOrderReview & {
    uploadedAt: string | null;
    sourceLabel: string | null;
  };
  pipeline: PipelineChecks & { available: boolean };
  labor: {
    rows: LaborRateRow[];
    multiplier: number;
    /** The week the rates cover — the week BEFORE the meeting week. */
    weekStart: string;
    weekEnd: string;
    uploadedAt: string | null;
    sourceLabel: string | null;
  };
  checks: Record<CheckKey, ManualCheck>;
  links: { reviews: string | null; lytx: string | null; ramp: string | null };
  sections: SectionProgress[];
  doneCount: number;
  sectionCount: number;
}

export class MeetingService {
  constructor(
    private readonly store: MeetingStore,
    private readonly workOrderStore: WorkOrderStore,
    private readonly provider: ProjectProvider,
    private readonly config: AppConfig,
    private readonly now: () => number = () => Date.now()
  ) {}

  resolveWeek(weekStart?: string): ReportingWeek {
    return weekStart
      ? getReportingWeekFromStart(weekStart, this.config.weekStartDay)
      : getReportingWeek(this.now(), this.config.weekStartDay);
  }

  /**
   * Labor rates review the PREVIOUS week: the Friday meeting looks at last
   * week's completed revenue against last week's production payroll (whose pay
   * date lands on the meeting Friday).
   */
  private laborWeek(week: ReportingWeek): ReportingWeek {
    return getReportingWeek(week.startMs - 7 * 86_400_000, this.config.weekStartDay);
  }

  /** Upload the Unpaid Invoices export and sync it into the follow-up list. */
  async uploadPastDue(
    rows: RawGrid,
    filename: string | null,
    weekStart?: string
  ): Promise<{ count: number; newCount: number; missingCount: number }> {
    const week = this.resolveWeek(weekStart);
    const parsed = parseUnpaidInvoices(rows);
    const existing = await this.store.getFollowUps();
    const nowIso = new Date(this.now()).toISOString();
    const sync = syncFollowUps(existing, parsed.invoices, week.weekStart, nowIso);
    await this.store.setFollowUps(sync.followUps);
    await this.store.setPastDueMeta({
      uploadedAt: nowIso,
      filename,
      sourceLabel: parsed.sourceLabel,
    });
    return {
      count: parsed.invoices.length,
      newCount: sync.newCount,
      missingCount: sync.missingCount,
    };
  }

  /** Patch one follow-up (reason / owner / action date / status / update note). */
  async updateFollowUp(
    invoiceNumber: string,
    patch: {
      reason?: string;
      owner?: string;
      ownerEmail?: string;
      actionDate?: string | null;
      status?: "open" | "resolved";
      note?: string;
      by?: string;
    },
    weekStart?: string
  ): Promise<FollowUp | null> {
    const week = this.resolveWeek(weekStart);
    const followUps = await this.store.getFollowUps();
    const fu = followUps[invoiceNumber];
    if (!fu) return null;
    const nowIso = new Date(this.now()).toISOString();

    if (patch.reason !== undefined) fu.reason = patch.reason;
    if (patch.owner !== undefined) fu.owner = patch.owner;
    if (patch.ownerEmail !== undefined) fu.ownerEmail = patch.ownerEmail;
    if (patch.actionDate !== undefined) fu.actionDate = patch.actionDate;
    if (patch.status !== undefined && patch.status !== fu.status) {
      fu.status = patch.status;
      fu.resolvedWeek = patch.status === "resolved" ? week.weekStart : null;
    }
    if (patch.note) {
      fu.updates.push({
        week: week.weekStart,
        note: patch.note,
        by: patch.by ?? null,
        at: nowIso,
      });
    }
    fu.updatedAt = nowIso;
    await this.store.setFollowUps(followUps);
    return fu;
  }

  /** Upload the Completed Projects report (labor-rate revenue source). */
  async uploadCompleted(
    rows: RawGrid,
    filename: string | null
  ): Promise<{ count: number }> {
    const parsed = parseCompletedProjects(rows);
    await this.store.setCompleted({
      jobs: parsed.jobs,
      uploadedAt: new Date(this.now()).toISOString(),
      filename,
      sourceLabel: parsed.sourceLabel,
    });
    return { count: parsed.jobs.length };
  }

  async clearCompleted(): Promise<void> {
    await this.store.setCompleted(null);
  }

  /** Summarise a payroll workbook's sheets (client picks the right week). */
  summarisePayroll(sheets: PayrollSheet[], weekStart?: string) {
    const week = this.laborWeek(this.resolveWeek(weekStart));
    return summarisePayrollWorkbook(sheets, week.weekStart, week.weekEnd);
  }

  async setLabor(
    weekStart: string,
    className: string,
    patch: {
      productionPayroll?: number | null;
      revenueOverride?: number | null;
      sheetName?: string | null;
      by?: string | null;
    }
  ): Promise<void> {
    const week = this.resolveWeek(weekStart);
    const doc = await this.store.getWeek(week.weekStart);
    const entry = doc.labor[className] ?? {
      productionPayroll: null,
      revenueOverride: null,
      sheetName: null,
      by: null,
    };
    if (patch.productionPayroll !== undefined)
      entry.productionPayroll = patch.productionPayroll;
    if (patch.revenueOverride !== undefined)
      entry.revenueOverride = patch.revenueOverride;
    if (patch.sheetName !== undefined) entry.sheetName = patch.sheetName;
    if (patch.by !== undefined) entry.by = patch.by;
    doc.labor[className] = entry;
    doc.updatedAt = new Date(this.now()).toISOString();
    await this.store.saveWeek(doc);
  }

  async setCheck(
    weekStart: string,
    key: CheckKey,
    patch: { status?: "pending" | "done"; notes?: string; by?: string }
  ): Promise<ManualCheck> {
    const week = this.resolveWeek(weekStart);
    const doc = await this.store.getWeek(week.weekStart);
    const check = doc.checks[key];
    if (patch.notes !== undefined) check.notes = patch.notes;
    if (patch.by !== undefined) check.by = patch.by;
    if (patch.status !== undefined) {
      check.status = patch.status;
      check.at = patch.status === "done" ? new Date(this.now()).toISOString() : null;
    }
    doc.updatedAt = new Date(this.now()).toISOString();
    await this.store.saveWeek(doc);
    return check;
  }

  async setSection(
    weekStart: string,
    key: SectionKey,
    done: boolean,
    by: string | null
  ): Promise<void> {
    const week = this.resolveWeek(weekStart);
    const doc = await this.store.getWeek(week.weekStart);
    doc.sections[key] = {
      done,
      by,
      at: done ? new Date(this.now()).toISOString() : null,
    };
    doc.updatedAt = new Date(this.now()).toISOString();
    await this.store.saveWeek(doc);
  }

  async setWoNote(
    woId: string,
    lead: string,
    cause: string,
    by: string | null
  ): Promise<WoNote> {
    const note: WoNote = {
      woId,
      lead,
      cause,
      by,
      at: new Date(this.now()).toISOString(),
    };
    await this.store.setWoNote(note);
    return note;
  }

  /** The whole meeting for a week, every agenda item assembled. */
  async getMeeting(weekStart?: string): Promise<MeetingView> {
    const week = this.resolveWeek(weekStart);
    const [followUps, pastDueMeta, woNotes, completed, doc, storedWo] =
      await Promise.all([
        this.store.getFollowUps(),
        this.store.getPastDueMeta(),
        this.store.getWoNotes(),
        this.store.getCompleted(),
        this.store.getWeek(week.weekStart),
        this.workOrderStore.get(),
      ]);

    let projects: Awaited<ReturnType<ProjectProvider["listAllProjects"]>> = [];
    let pipelineAvailable = true;
    try {
      projects = await this.provider.listAllProjects();
    } catch {
      pipelineAvailable = false;
    }

    const pastDue = this.buildPastDue(followUps, pastDueMeta, week);
    const workOrders = buildWorkOrderReview(
      [...storedWo.uploaded, ...storedWo.manual],
      woNotes,
      this.now()
    );
    // The Friday meeting looks AHEAD: check that the next two weeks are full
    // and evenly scheduled (on Fri 7/31 that's 8/2–8/8 and 8/9–8/15).
    const lookAhead = [1, 2].map((n) =>
      getReportingWeek(week.startMs + n * 7 * 86_400_000, this.config.weekStartDay)
    );
    const pipeline = buildPipelineChecks(projects, lookAhead, this.config.customFields);
    const laborWeek = this.laborWeek(week);
    const laborRows = buildLaborRates(
      completed?.jobs ?? [],
      laborWeek,
      doc.labor,
      this.config.laborMultiplier
    );

    const sections = this.buildSections(
      doc,
      pastDue,
      workOrders,
      pipeline.totalJobs > 0,
      laborRows
    );
    const doneCount = sections.filter((s) => s.done).length;

    return {
      week: { weekStart: week.weekStart, weekEnd: week.weekEnd, quarter: week.quarter },
      pastDue,
      workOrders: {
        ...workOrders,
        uploadedAt: storedWo.uploadedAt,
        sourceLabel: storedWo.sourceLabel,
      },
      pipeline: { ...pipeline, available: pipelineAvailable && pipeline.totalJobs > 0 },
      labor: {
        rows: laborRows,
        multiplier: this.config.laborMultiplier,
        weekStart: laborWeek.weekStart,
        weekEnd: laborWeek.weekEnd,
        uploadedAt: completed?.uploadedAt ?? null,
        sourceLabel: completed?.sourceLabel ?? null,
      },
      checks: doc.checks,
      links: this.config.meetingLinks,
      sections,
      doneCount,
      sectionCount: SECTION_KEYS.length,
    };
  }

  private buildPastDue(
    followUps: Record<string, FollowUp>,
    meta: StoredUploadMeta | null,
    week: ReportingWeek
  ): PastDueSection {
    const classes = new Map<string, PastDueClassGroup>();
    const likelyResolved: FollowUpView[] = [];
    let openCount = 0;
    let carryoverCount = 0;
    let needsInfoCount = 0;

    for (const fu of Object.values(followUps)) {
      // Resolved items disappear from the meeting once their week has passed.
      if (fu.status === "resolved" && fu.resolvedWeek !== week.weekStart) continue;

      const carriedOver = fu.status === "open" && fu.firstSeenWeek < week.weekStart;
      const view: FollowUpView = {
        ...fu,
        carriedOver,
        updatedThisWeek: fu.updates.some((u) => u.week === week.weekStart),
      };

      if (fu.status === "open" && !fu.inLatestExport) {
        likelyResolved.push(view);
        continue;
      }
      if (fu.status === "open") {
        openCount++;
        if (carriedOver) carryoverCount++;
        if (!fu.reason || !fu.owner) needsInfoCount++;
      }

      const cls = fu.className || "Unassigned";
      let group = classes.get(cls);
      if (!group) {
        group = { className: cls, totalBalance: 0, items: [] };
        classes.set(cls, group);
      }
      group.items.push(view);
      if (fu.status === "open") group.totalBalance += fu.balance ?? 0;
    }

    for (const group of classes.values()) {
      group.totalBalance = Math.round(group.totalBalance * 100) / 100;
      group.items.sort((a, b) => (b.balance ?? 0) - (a.balance ?? 0));
    }
    likelyResolved.sort((a, b) => (b.balance ?? 0) - (a.balance ?? 0));

    return {
      meta,
      classes: [...classes.values()].sort((a, b) =>
        a.className.localeCompare(b.className)
      ),
      likelyResolved,
      openCount,
      carryoverCount,
      needsInfoCount,
    };
  }

  private buildSections(
    doc: MeetingWeekDoc,
    pastDue: PastDueSection,
    workOrders: WorkOrderReview,
    pipelineLoaded: boolean,
    labor: LaborRateRow[]
  ): SectionProgress[] {
    const auto: Record<SectionKey, boolean> = {
      // Every open item has a reason + owner, and every carryover got an update.
      pastdue:
        pastDue.meta !== null &&
        pastDue.needsInfoCount === 0 &&
        pastDue.classes
          .flatMap((c) => c.items)
          .filter((i) => i.carriedOver)
          .every((i) => i.updatedThisWeek),
      // Every open warranty has been tagged with a lead + cause.
      workorders:
        (workOrders.totalOpen > 0 || workOrders.totalCompleted > 0) &&
        workOrders.warranties
          .filter((w) => w.open)
          .every((w) => w.lead && w.cause),
      pipeline: pipelineLoaded,
      // Payroll entered for every location that completed revenue this week.
      labor:
        labor.length > 0 &&
        labor
          .filter((l) => l.completedRevenue > 0 || l.revenueOverride !== null)
          .every((l) => l.productionPayroll !== null),
      reviews: doc.checks.reviews.status === "done",
      lytx: doc.checks.lytx.status === "done",
      ramp: doc.checks.ramp.status === "done",
    };

    return SECTION_KEYS.map((key) => {
      const manual = doc.sections[key] ?? null;
      // Manual sign-off wins; otherwise fall back to the computed status.
      return { key, autoDone: auto[key], manual, done: manual?.done ?? auto[key] };
    });
  }
}
