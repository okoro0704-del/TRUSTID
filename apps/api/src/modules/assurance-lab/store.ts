/**
 * Assurance Lab evidence store (filesystem, development/testing only).
 *
 * Holds pseudonymous lab participants, sessions, capture evidence (embedding +
 * metadata, never images), and PAD attempts. It is not the production identity
 * database and never touches Prisma, users, TrustIDs, or face templates.
 */
import { randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve, sep } from "node:path";
import type {
  LabCaptureRecord,
  LabPadAttempt,
  LabParticipant,
  LabSession,
  LabStudyConfig,
} from "@trustid/sdk/assurance-lab";

const ID_PATTERN = /^lab_[psca]_[a-f0-9]{24}$/;
const STUDY_PATTERN = /^[a-zA-Z0-9_-]{3,64}$/;

export type LabIdKind = "p" | "s" | "c" | "a";

export function newLabId(kind: LabIdKind): string {
  return `lab_${kind}_${randomBytes(12).toString("hex")}`;
}

export function isLabId(value: unknown, kind?: LabIdKind): value is string {
  return typeof value === "string" && ID_PATTERN.test(value) && (!kind || value.startsWith(`lab_${kind}_`));
}

export function getAssuranceLabRoot(): string {
  const configured = process.env.TRUSTID_ASSURANCE_LAB_ROOT?.trim();
  return resolve(configured || join(process.cwd(), "artifacts", "assurance-lab"));
}

function safeJoin(root: string, ...parts: string[]): string {
  const full = resolve(root, ...parts);
  if (full !== root && !full.startsWith(root + sep)) throw new Error("assurance_lab_path_escape");
  return full;
}

function writeJsonAtomic(path: string, value: unknown): void {
  mkdirSync(resolve(path, ".."), { recursive: true });
  const tmp = `${path}.${randomBytes(4).toString("hex")}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2), { encoding: "utf8", mode: 0o600 });
  renameSync(tmp, path);
}

function readJson<T>(path: string): T | null {
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

function listJson<T>(dir: string): T[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")) as T);
}

export type LabWithdrawalResult = {
  participantId: string;
  withdrawn: boolean;
  deleted: { sessions: number; captures: number; padAttempts: number; reports: number };
};

/** One study directory: study.json, participants/<id>/{participant,sessions,captures,pad}. */
export class AssuranceLabStore {
  readonly root: string;
  readonly studyDir: string;

  constructor(
    readonly studyId: string,
    root = getAssuranceLabRoot(),
  ) {
    if (!STUDY_PATTERN.test(studyId)) throw new Error("assurance_lab_invalid_study_id");
    this.root = resolve(root);
    this.studyDir = safeJoin(this.root, studyId);
  }

  private participantDir(participantId: string): string {
    if (!isLabId(participantId, "p")) throw new Error("assurance_lab_invalid_participant_id");
    return safeJoin(this.studyDir, "participants", participantId);
  }

  readStudy(): LabStudyConfig | null {
    return readJson<LabStudyConfig>(safeJoin(this.studyDir, "study.json"));
  }

  writeStudy(config: LabStudyConfig): void {
    writeJsonAtomic(safeJoin(this.studyDir, "study.json"), config);
  }

  saveParticipant(p: LabParticipant): void {
    writeJsonAtomic(join(this.participantDir(p.participantId), "participant.json"), p);
  }

  getParticipant(participantId: string): LabParticipant | null {
    if (!isLabId(participantId, "p")) return null;
    return readJson<LabParticipant>(join(this.participantDir(participantId), "participant.json"));
  }

  listParticipants(): LabParticipant[] {
    const dir = safeJoin(this.studyDir, "participants");
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .filter((d) => isLabId(d, "p"))
      .sort()
      .map((d) => this.getParticipant(d))
      .filter((p): p is LabParticipant => p != null);
  }

  saveSession(s: LabSession): void {
    if (!isLabId(s.sessionId, "s")) throw new Error("assurance_lab_invalid_session_id");
    writeJsonAtomic(join(this.participantDir(s.participantId), "sessions", `${s.sessionId}.json`), s);
  }

  findSession(sessionId: string): LabSession | null {
    if (!isLabId(sessionId, "s")) return null;
    for (const p of this.listParticipants()) {
      const s = readJson<LabSession>(join(this.participantDir(p.participantId), "sessions", `${sessionId}.json`));
      if (s) return s;
    }
    return null;
  }

  listSessions(participantId?: string): LabSession[] {
    const ids = participantId ? [participantId] : this.listParticipants().map((p) => p.participantId);
    return ids.flatMap((id) => listJson<LabSession>(join(this.participantDir(id), "sessions")));
  }

  saveCapture(c: LabCaptureRecord): void {
    if (!isLabId(c.captureId, "c")) throw new Error("assurance_lab_invalid_capture_id");
    if (c.rawImageRetained !== false) throw new Error("assurance_lab_raw_image_forbidden");
    writeJsonAtomic(join(this.participantDir(c.participantId), "captures", `${c.captureId}.json`), c);
  }

  listCaptures(participantId?: string): LabCaptureRecord[] {
    const ids = participantId ? [participantId] : this.listParticipants().map((p) => p.participantId);
    return ids.flatMap((id) => listJson<LabCaptureRecord>(join(this.participantDir(id), "captures")));
  }

  savePadAttempt(a: LabPadAttempt): void {
    if (!isLabId(a.attemptId, "a")) throw new Error("assurance_lab_invalid_attempt_id");
    if (a.rawMediaRetained !== false) throw new Error("assurance_lab_raw_media_forbidden");
    writeJsonAtomic(join(this.participantDir(a.participantId), "pad", `${a.attemptId}.json`), a);
  }

  listPadAttempts(participantId?: string): LabPadAttempt[] {
    const ids = participantId ? [participantId] : this.listParticipants().map((p) => p.participantId);
    return ids.flatMap((id) => listJson<LabPadAttempt>(join(this.participantDir(id), "pad")));
  }

  private countJson(dir: string): number {
    return existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".json")).length : 0;
  }

  /** Cached reports are derived from participant data, so any deletion invalidates them. */
  invalidateReports(): number {
    const dir = safeJoin(this.studyDir, "reports");
    const n = this.countJson(dir);
    rmSync(dir, { recursive: true, force: true });
    return n;
  }

  writeReport(name: string, json: string): string {
    if (!/^[a-z0-9_-]{1,64}\.json$/.test(name)) throw new Error("assurance_lab_invalid_report_name");
    const path = safeJoin(this.studyDir, "reports", name);
    mkdirSync(resolve(path, ".."), { recursive: true });
    writeFileSync(path, json, { encoding: "utf8", mode: 0o600 });
    return path;
  }

  /**
   * Withdrawal deletes every session, capture (embedding), and PAD attempt for
   * the participant, invalidates cached reports, and keeps only a tombstone
   * (pseudonym + WITHDRAWN) so the withdrawal itself is auditable.
   */
  withdraw(participantId: string, now = new Date()): LabWithdrawalResult | null {
    const participant = this.getParticipant(participantId);
    if (!participant) return null;
    const dir = this.participantDir(participantId);
    const deleted = {
      sessions: this.countJson(join(dir, "sessions")),
      captures: this.countJson(join(dir, "captures")),
      padAttempts: this.countJson(join(dir, "pad")),
      reports: 0,
    };
    for (const sub of ["sessions", "captures", "pad"]) rmSync(join(dir, sub), { recursive: true, force: true });
    deleted.reports = this.invalidateReports();
    this.saveParticipant({ ...participant, status: "WITHDRAWN" });
    writeJsonAtomic(join(dir, "withdrawal.json"), { participantId, withdrawnAt: now.toISOString() });
    return { participantId, withdrawn: true, deleted };
  }

  /** Delete evidence older than the study retention window. */
  purgeExpired(retentionDays: number, now = new Date()): { captures: number; padAttempts: number } {
    const cutoff = now.getTime() - retentionDays * 86_400_000;
    let captures = 0;
    let padAttempts = 0;
    for (const p of this.listParticipants()) {
      const dir = this.participantDir(p.participantId);
      for (const c of this.listCaptures(p.participantId)) {
        if (Date.parse(c.capturedAt) < cutoff) {
          rmSync(join(dir, "captures", `${c.captureId}.json`), { force: true });
          captures++;
        }
      }
      for (const a of this.listPadAttempts(p.participantId)) {
        if (Date.parse(a.recordedAt) < cutoff) {
          rmSync(join(dir, "pad", `${a.attemptId}.json`), { force: true });
          padAttempts++;
        }
      }
    }
    if (captures || padAttempts) this.invalidateReports();
    return { captures, padAttempts };
  }
}
