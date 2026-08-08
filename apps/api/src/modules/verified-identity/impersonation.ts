import {
  AUDIT_EVENTS,
  IMPERSONATION_REPORT_STATUS,
  IMPERSONATION_REPORT_TYPES,
} from "@trustid/shared";
import { prisma } from "../../db/client.js";
import { recordAudit } from "../audit/service.js";

/**
 * Impersonation reporting — NEVER auto-merges accounts based on
 * name, email, or photograph similarity.
 */
export async function createImpersonationReport(input: {
  reporterUserId: string;
  type: string;
  reason: string;
  subjectTrustId?: string;
  evidenceNote?: string;
  metadata?: Record<string, unknown>;
  ip?: string;
  userAgent?: string;
}) {
  const allowed = Object.values(IMPERSONATION_REPORT_TYPES);
  if (!allowed.includes(input.type as (typeof allowed)[number])) {
    throw Object.assign(new Error("Invalid report type"), {
      statusCode: 400,
      code: "invalid_request",
    });
  }
  if (!input.reason.trim()) {
    throw Object.assign(new Error("Reason required"), {
      statusCode: 400,
      code: "invalid_request",
    });
  }

  let subjectUserId: string | undefined;
  if (input.subjectTrustId) {
    const subject = await prisma.user.findUnique({
      where: { trustId: input.subjectTrustId.trim() },
    });
    // Do not reveal whether trustId exists beyond storing if found
    subjectUserId = subject?.id;
  }

  // Never allow reporting yourself as a merge signal
  if (subjectUserId && subjectUserId === input.reporterUserId) {
    throw Object.assign(new Error("Invalid subject"), {
      statusCode: 400,
      code: "invalid_request",
    });
  }

  const report = await prisma.impersonationReport.create({
    data: {
      reporterUserId: input.reporterUserId,
      subjectUserId: subjectUserId ?? null,
      subjectTrustId: input.subjectTrustId?.trim() || null,
      type: input.type,
      status: IMPERSONATION_REPORT_STATUS.OPEN,
      reason: input.reason.trim().slice(0, 2000),
      evidenceNote: input.evidenceNote?.trim().slice(0, 2000) ?? null,
      metadata: JSON.stringify({
        ...(input.metadata ?? {}),
        // Explicit non-merge policy marker
        autoMerge: false,
        policy: "name_photo_username_never_prove_identity",
      }),
    },
  });

  await recordAudit({
    type: AUDIT_EVENTS.IDENTITY_IMPERSONATION_REPORTED,
    userId: input.reporterUserId,
    actorType: "user",
    actorId: input.reporterUserId,
    metadata: {
      reportId: report.id,
      type: input.type,
      hasSubject: Boolean(subjectUserId),
    },
    ip: input.ip,
    userAgent: input.userAgent,
  });

  return {
    id: report.id,
    type: report.type,
    status: report.status,
    createdAt: report.createdAt.toISOString(),
    note: "Report recorded for review. Accounts are never automatically merged based on name or photograph.",
  };
}

export async function listOwnImpersonationReports(reporterUserId: string) {
  const rows = await prisma.impersonationReport.findMany({
    where: { reporterUserId },
    orderBy: { createdAt: "desc" },
    take: 50,
  });
  return rows.map((r) => ({
    id: r.id,
    type: r.type,
    status: r.status,
    reason: r.reason,
    subjectTrustId: r.subjectTrustId,
    createdAt: r.createdAt.toISOString(),
    resolvedAt: r.resolvedAt?.toISOString() ?? null,
  }));
}
