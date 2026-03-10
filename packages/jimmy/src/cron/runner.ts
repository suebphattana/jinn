import type { CronJob, Connector, JinnConfig } from "../shared/types.js";
import { logger } from "../shared/logger.js";
import { appendRunLog } from "./jobs.js";
import { scanOrg, findEmployee } from "../gateway/org.js";
import { CronConnector } from "../connectors/cron/index.js";
import type { SessionManager } from "../sessions/manager.js";

export async function runCronJob(
  job: CronJob,
  sessionManager: SessionManager,
  config: JinnConfig,
  connectors: Map<string, Connector>,
): Promise<void> {
  const startTime = Date.now();
  logger.info(`Cron job "${job.name}" (${job.id}) starting`);

  const delivery = job.delivery || config.cron?.defaultDelivery;
  const cooSlug = config.portal?.portalName?.toLowerCase() || "jinn";
  if (delivery && job.employee && job.employee !== cooSlug) {
    logger.warn(
      `Cron job "${job.name}" targets employee "${job.employee}" with delivery to ${delivery.connector}:${delivery.channel}. ` +
      `Recommended pattern: target "${cooSlug}" and let the COO delegate to "${job.employee}" via a child session for output review/filtering.`,
    );
  }

  let employee;
  if (job.employee) {
    const orgRegistry = scanOrg();
    employee = findEmployee(job.employee, orgRegistry);
  }

  const connector = new CronConnector(connectors, delivery);
  const startedAt = new Date().toISOString();
  const sessionKey = `cron:${job.id}:${Date.now()}`;

  try {
    await sessionManager.route(
      {
        connector: connector.name,
        source: "cron",
        sessionKey,
        replyContext: {
          channel: delivery?.channel || job.id,
          messageTs: null,
          cronJobId: job.id,
          cronJobName: job.name,
          deliveryConnector: delivery?.connector ?? null,
        },
        messageId: undefined,
        channel: delivery?.channel || job.id,
        thread: undefined,
        user: "system",
        userId: "system",
        text: job.prompt,
        attachments: [],
        raw: { jobId: job.id, trigger: "cron" },
        transportMeta: {
          cronJobId: job.id,
          cronJobName: job.name,
          deliveryConnector: delivery?.connector ?? null,
          deliveryChannel: delivery?.channel ?? null,
        },
      },
      connector,
      {
        employee,
        engine: job.engine || config.engines.default,
        model: job.model || config.engines[(job.engine || config.engines.default) as "claude" | "codex"]?.model,
        title: job.name,
      },
    );

    appendRunLog(job.id, {
      timestamp: startedAt,
      sessionKey,
      status: "success",
      durationMs: Date.now() - startTime,
      error: null,
      resultPreview: null,
    });
    logger.info(`Cron job "${job.name}" completed in ${Date.now() - startTime}ms`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    appendRunLog(job.id, {
      timestamp: startedAt,
      sessionKey,
      status: "error",
      durationMs: Date.now() - startTime,
      error: message,
      resultPreview: null,
    });
    logger.error(`Cron job "${job.name}" failed: ${message}`);
  }
}
