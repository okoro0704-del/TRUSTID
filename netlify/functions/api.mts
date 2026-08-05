import { copyFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  Handler,
  APIGatewayProxyEvent,
  APIGatewayProxyResult,
  Context,
} from "aws-lambda";
import awsLambdaFastify from "@fastify/aws-lambda";
import { buildApp } from "../../apps/api/dist/app.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

function ensureDatabase() {
  const tmpDb = "/tmp/trustid.db";
  process.env.DATABASE_URL = process.env.DATABASE_URL || `file:${tmpDb}`;

  if (!existsSync(tmpDb)) {
    const template = join(__dirname, "../../apps/api/prisma/template.db");
    if (!existsSync(template)) {
      throw new Error(
        "TrustID database template missing. Rebuild with npm run build:web.",
      );
    }
    copyFileSync(template, tmpDb);
  }
}

type LambdaHandler = (
  event: APIGatewayProxyEvent,
  context: Context,
) => Promise<APIGatewayProxyResult>;

let proxy: LambdaHandler | null = null;

async function getProxy() {
  if (proxy) return proxy;
  ensureDatabase();

  if (!process.env.WEBAUTHN_ORIGIN && process.env.URL) {
    process.env.WEBAUTHN_ORIGIN = process.env.URL;
  }
  if (!process.env.WEBAUTHN_RP_ID && process.env.URL) {
    process.env.WEBAUTHN_RP_ID = new URL(process.env.URL).hostname;
  }
  if (!process.env.COOKIE_SECRET) {
    process.env.COOKIE_SECRET =
      process.env.SESSION_SECRET || "netlify-trustid-cookie-secret";
  }

  const app = await buildApp();
  await app.ready();
  proxy = awsLambdaFastify(app, {
    binaryMimeTypes: ["application/octet-stream"],
  }) as LambdaHandler;
  return proxy;
}

function normalizeEvent(event: APIGatewayProxyEvent): APIGatewayProxyEvent {
  let path = event.path || "/";
  path = path.replace(/^\/\.netlify\/functions\/api/, "");
  path = path.replace(/^\/api/, "");
  if (!path.startsWith("/")) path = `/${path}`;
  if (path === "/") path = "/health";

  const withRaw = event as APIGatewayProxyEvent & { rawPath?: string };
  let rawPath = withRaw.rawPath;
  if (rawPath) {
    rawPath = rawPath.replace(/^\/\.netlify\/functions\/api/, "");
    rawPath = rawPath.replace(/^\/api/, "");
    if (!rawPath.startsWith("/")) rawPath = `/${rawPath}`;
  }

  return {
    ...event,
    path,
    ...(rawPath ? { rawPath } : {}),
  } as APIGatewayProxyEvent;
}

export const handler: Handler = async (event, context) => {
  const run = await getProxy();
  return run(normalizeEvent(event as APIGatewayProxyEvent), context);
};
