import { promises as fs } from "node:fs";
import path from "node:path";
import type { FollowUp } from "../domain/pastDue.js";
import type { CompletedJob } from "../domain/completedProjects.js";
import type { MeetingWeekDoc, WoNote } from "../domain/meeting.js";
import { emptyWeekDoc } from "../domain/meeting.js";
import type { KvClient } from "./kv/kvClient.js";

/**
 * Persistence for the Friday Production Meeting: past-due follow-ups (carried
 * across weeks), warranty lead/cause tags, the latest completed-projects
 * upload, and one document per meeting week (checks, labor inputs, sign-offs).
 */

export interface StoredUploadMeta {
  uploadedAt: string;
  filename: string | null;
  sourceLabel: string | null;
}

export interface StoredCompleted extends StoredUploadMeta {
  jobs: CompletedJob[];
}

export interface MeetingStore {
  getFollowUps(): Promise<Record<string, FollowUp>>;
  setFollowUps(followUps: Record<string, FollowUp>): Promise<void>;
  getPastDueMeta(): Promise<StoredUploadMeta | null>;
  setPastDueMeta(meta: StoredUploadMeta | null): Promise<void>;
  getWoNotes(): Promise<Record<string, WoNote>>;
  setWoNote(note: WoNote): Promise<void>;
  getCompleted(): Promise<StoredCompleted | null>;
  setCompleted(completed: StoredCompleted | null): Promise<void>;
  getWeek(weekStart: string): Promise<MeetingWeekDoc>;
  saveWeek(doc: MeetingWeekDoc): Promise<void>;
}

interface MeetingFileShape {
  followUps: Record<string, FollowUp>;
  pastDueMeta: StoredUploadMeta | null;
  woNotes: Record<string, WoNote>;
  completed: StoredCompleted | null;
  weeks: Record<string, MeetingWeekDoc>;
}

const EMPTY_FILE: MeetingFileShape = {
  followUps: {},
  pastDueMeta: null,
  woNotes: {},
  completed: null,
  weeks: {},
};

export class JsonMeetingStore implements MeetingStore {
  private readonly file: string;
  private writeChain: Promise<unknown> = Promise.resolve();

  constructor(dataDir: string) {
    this.file = path.resolve(dataDir, "meeting.json");
  }

  private async read(): Promise<MeetingFileShape> {
    try {
      const raw = JSON.parse(await fs.readFile(this.file, "utf8"));
      return { ...structuredClone(EMPTY_FILE), ...raw };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT")
        return structuredClone(EMPTY_FILE);
      throw err;
    }
  }

  private async write(mutate: (s: MeetingFileShape) => void): Promise<void> {
    const run = async () => {
      const current = await this.read();
      mutate(current);
      await fs.mkdir(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      await fs.writeFile(tmp, JSON.stringify(current), "utf8");
      await fs.rename(tmp, this.file);
    };
    this.writeChain = this.writeChain.then(run, run);
    await this.writeChain;
  }

  async getFollowUps() {
    return (await this.read()).followUps;
  }
  setFollowUps(followUps: Record<string, FollowUp>) {
    return this.write((s) => {
      s.followUps = followUps;
    });
  }
  async getPastDueMeta() {
    return (await this.read()).pastDueMeta;
  }
  setPastDueMeta(meta: StoredUploadMeta | null) {
    return this.write((s) => {
      s.pastDueMeta = meta;
    });
  }
  async getWoNotes() {
    return (await this.read()).woNotes;
  }
  setWoNote(note: WoNote) {
    return this.write((s) => {
      s.woNotes[note.woId] = note;
    });
  }
  async getCompleted() {
    return (await this.read()).completed;
  }
  setCompleted(completed: StoredCompleted | null) {
    return this.write((s) => {
      s.completed = completed;
    });
  }
  async getWeek(weekStart: string) {
    return (await this.read()).weeks[weekStart] ?? emptyWeekDoc(weekStart);
  }
  saveWeek(doc: MeetingWeekDoc) {
    return this.write((s) => {
      s.weeks[doc.weekStart] = doc;
    });
  }
}

export class KvMeetingStore implements MeetingStore {
  private static readonly FOLLOWUPS = "meeting:followups";
  private static readonly PASTDUE_META = "meeting:pastdue-meta";
  private static readonly WONOTES = "meeting:wonotes";
  private static readonly COMPLETED = "meeting:completed";
  private static weekKey(weekStart: string): string {
    return `meeting:week:${weekStart}`;
  }

  constructor(private readonly kv: KvClient) {}

  async getFollowUps() {
    return (
      (await this.kv.get<Record<string, FollowUp>>(KvMeetingStore.FOLLOWUPS)) ?? {}
    );
  }
  setFollowUps(followUps: Record<string, FollowUp>) {
    return this.kv.set(KvMeetingStore.FOLLOWUPS, followUps);
  }
  async getPastDueMeta() {
    return await this.kv.get<StoredUploadMeta>(KvMeetingStore.PASTDUE_META);
  }
  setPastDueMeta(meta: StoredUploadMeta | null) {
    return this.kv.set(KvMeetingStore.PASTDUE_META, meta);
  }
  async getWoNotes() {
    return (await this.kv.get<Record<string, WoNote>>(KvMeetingStore.WONOTES)) ?? {};
  }
  async setWoNote(note: WoNote) {
    const notes = await this.getWoNotes();
    notes[note.woId] = note;
    await this.kv.set(KvMeetingStore.WONOTES, notes);
  }
  async getCompleted() {
    return await this.kv.get<StoredCompleted>(KvMeetingStore.COMPLETED);
  }
  setCompleted(completed: StoredCompleted | null) {
    return this.kv.set(KvMeetingStore.COMPLETED, completed);
  }
  async getWeek(weekStart: string) {
    return (
      (await this.kv.get<MeetingWeekDoc>(KvMeetingStore.weekKey(weekStart))) ??
      emptyWeekDoc(weekStart)
    );
  }
  saveWeek(doc: MeetingWeekDoc) {
    return this.kv.set(KvMeetingStore.weekKey(doc.weekStart), doc);
  }
}

export class MemoryMeetingStore implements MeetingStore {
  private state: MeetingFileShape = structuredClone(EMPTY_FILE);

  async getFollowUps() {
    return structuredClone(this.state.followUps);
  }
  async setFollowUps(followUps: Record<string, FollowUp>) {
    this.state.followUps = structuredClone(followUps);
  }
  async getPastDueMeta() {
    return structuredClone(this.state.pastDueMeta);
  }
  async setPastDueMeta(meta: StoredUploadMeta | null) {
    this.state.pastDueMeta = structuredClone(meta);
  }
  async getWoNotes() {
    return structuredClone(this.state.woNotes);
  }
  async setWoNote(note: WoNote) {
    this.state.woNotes[note.woId] = structuredClone(note);
  }
  async getCompleted() {
    return structuredClone(this.state.completed);
  }
  async setCompleted(completed: StoredCompleted | null) {
    this.state.completed = structuredClone(completed);
  }
  async getWeek(weekStart: string) {
    return structuredClone(this.state.weeks[weekStart] ?? emptyWeekDoc(weekStart));
  }
  async saveWeek(doc: MeetingWeekDoc) {
    this.state.weeks[doc.weekStart] = structuredClone(doc);
  }
}
