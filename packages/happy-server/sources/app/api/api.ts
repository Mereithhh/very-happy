import { spaFallback } from './spaFallback';
import { webStaticOptions } from './staticCache';
import { enableResponseCompression } from './responseCompression';
import { startBusinessAudit, stopBusinessAudit } from '@/app/audit/producer';
import { auditLoginFailure } from '@/app/audit/requestAudit';
import { teamRoutes } from './routes/teamRoutes';
import { projectRoutes } from './routes/projectRoutes';
import { automationRoutes } from './routes/automationRoutes';
import { attentionRoutes } from './routes/attentionRoutes';
import { feedbackRoutes } from './routes/feedbackRoutes';
import { promptQueueRoutes } from './routes/promptQueueRoutes';
import fastify from "fastify";
import { log, logger } from "@/utils/log";
import { serializerCompiler, validatorCompiler, ZodTypeProvider } from "fastify-type-provider-zod";
import { onShutdown } from "@/utils/shutdown";
import { Fastify } from "./types";
import { authRoutes } from "./routes/authRoutes";
import { pushRoutes } from "./routes/pushRoutes";
import { sessionRoutes } from "./routes/sessionRoutes";
import { connectRoutes } from "./routes/connectRoutes";
import { accountRoutes } from "./routes/accountRoutes";
import { startSocket } from "./socket";
import { machinesRoutes } from "./routes/machinesRoutes";
import { devRoutes } from "./routes/devRoutes";
import { versionRoutes } from "./routes/versionRoutes";
import { modelRoutes } from "./routes/modelRoutes";
import { voiceRoutes } from "./routes/voiceRoutes";
import { artifactsRoutes } from "./routes/artifactsRoutes";
import { accessKeysRoutes } from "./routes/accessKeysRoutes";
import { enableMonitoring } from "./utils/enableMonitoring";
import { enableErrorHandlers } from "./utils/enableErrorHandlers";
import { enableAuthentication } from "./utils/enableAuthentication";
import { userRoutes } from "./routes/userRoutes";
import { feedRoutes } from "./routes/feedRoutes";
import { unlockRoutes } from "./routes/unlockRoutes";
import { accountAuthRoutes } from "./routes/accountAuthRoutes";
import { oidcAuthRoutes } from "./routes/oidcAuthRoutes";
import { migrationRoutes } from "./routes/migrationRoutes";
import { kvRoutes } from "./routes/kvRoutes";
import { v3SessionRoutes } from "./routes/v3SessionRoutes";
import { attachmentRoutes } from "./routes/attachmentRoutes";
import { isLocalStorage, getLocalFilesDir } from "@/storage/files";
import * as path from "path";
import { runtimeConfigScript, readHtmlBrand } from './htmlConfigInjection';
import { parseCspMode } from './securityHeaders';
import { webDocumentOnSend } from './webDocumentOnSend';
import * as fs from "fs";
import { resolveTrustProxy, type TrustedProxyConfig } from './trustProxy';
import { configureClientIpTrust, requestLogSerializer } from './clientIp';
import { configuredResourceLimit } from './resourceLimits';
import { relayRoutes } from './routes/relayRoutes';
import { sessionShareRoutes } from './routes/sessionShareRoutes';
import { sessionShareLinkRoutes } from './routes/sessionShareLinkRoutes';
import { connectionDiagnosticsRoutes } from './routes/connectionDiagnosticsRoutes';
import { cspReportRoutes } from './routes/cspReportRoutes';
import { relayFeatureConfig } from '@/app/relay/relayConfig';

export interface StartApiOptions {
    port?: number;
    host?: string;
    staticDir?: string;
    injectHtmlConfig?: Record<string, unknown>;
    /** B-638: operator brand files served read-only at `/brand/` (see standalone `BRAND_ASSETS_DIR`). */
    brandAssetsDir?: string;
    trustProxy?: TrustedProxyConfig;
}

export async function startApi(opts: StartApiOptions = {}) {

    // Configure
    log('Starting API...');
    // Parse once at startup so a configured relay fleet with a missing/weak
    // signing secret fails before accepting traffic instead of surfacing as a
    // request-time 500.
    const relays = relayFeatureConfig();

    // Start API
    const configuredBodyLimit = configuredResourceLimit('HTTP_BODY_LIMIT_BYTES', 1024 * 1024);
    const trustProxy = opts.trustProxy ?? resolveTrustProxy(process.env.TRUST_PROXY);
    configureClientIpTrust(trustProxy);
    const app = fastify({
        // Request logs report the resolved end-user IP (clientIp), not the edge hop.
        loggerInstance: logger.child({}, { serializers: { req: requestLogSerializer } }),
        bodyLimit: configuredBodyLimit === 0 ? Number.MAX_SAFE_INTEGER : configuredBodyLimit,
        trustProxy,
    });
    startBusinessAudit();
    app.addHook('onResponse', async (request, reply) => { auditLoginFailure(request, reply.statusCode); });
    app.addHook('onClose', async () => { stopBusinessAudit(); });
    app.register(import('@fastify/cors'), {
        origin: '*',
        allowedHeaders: '*',
        methods: ['GET', 'POST', 'PUT', 'DELETE']
    });

    // B-818: JSON API responses go out br/gzip (responseCompression.ts).
    enableResponseCompression(app);

    // Required for local-mode attachment uploads (PUT /v1/sessions/:id/attachments/:file).
    // Fastify v5 rejects unknown media types with 415 before reaching the handler.
    app.addContentTypeParser(
        'application/octet-stream',
        { parseAs: 'buffer' },
        (_req, body, done) => done(null, body),
    );

    // Root handler — when not serving a static webapp, return a banner.
    // When serving a static webapp, @fastify/static handles `/` via its index.
    if (!opts.staticDir) {
        app.get('/', function (request, reply) {
            reply.send('Welcome to Happy Server!');
        });
    }

    // Create typed provider
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    const typed = app.withTypeProvider<ZodTypeProvider>() as unknown as Fastify;

    // Enable features
    enableMonitoring(typed);
    enableErrorHandlers(typed, { skipNotFoundHandler: !!opts.staticDir });
    enableAuthentication(typed);

    // Serve local files when using local storage
    if (isLocalStorage()) {
        app.get('/files/*', function (request, reply) {
            const filePath = (request.params as any)['*'];
            const baseDir = path.resolve(getLocalFilesDir());
            const fullPath = path.resolve(baseDir, filePath);
            if (!fullPath.startsWith(baseDir + path.sep)) {
                reply.code(403).send('Forbidden');
                return;
            }
            if (!fs.existsSync(fullPath)) {
                reply.code(404).send('Not found');
                return;
            }
            const stream = fs.createReadStream(fullPath);
            reply.send(stream);
        });
    }

    // Routes
    authRoutes(typed);
    pushRoutes(typed);
    sessionRoutes(typed);
    teamRoutes(typed);
    projectRoutes(typed);
    attentionRoutes(typed);
    feedbackRoutes(typed);
    automationRoutes(typed);
    promptQueueRoutes(typed);
    accountRoutes(typed);
    connectRoutes(typed);
    machinesRoutes(typed);
    artifactsRoutes(typed);
    accessKeysRoutes(typed);
    devRoutes(typed);
    versionRoutes(typed);
    modelRoutes(typed);
    voiceRoutes(typed);
    userRoutes(typed);
    feedRoutes(typed);
    unlockRoutes(typed);
    accountAuthRoutes(typed);
    oidcAuthRoutes(typed);
    migrationRoutes(typed);
    kvRoutes(typed);
    v3SessionRoutes(typed);
    attachmentRoutes(typed);
    relayRoutes(typed);
    sessionShareRoutes(typed);
    sessionShareLinkRoutes(typed);
    connectionDiagnosticsRoutes(typed);
    cspReportRoutes(typed);

    // Static webapp (self-host mode)
    if (opts.staticDir) {
        const fastifyStatic = (await import('@fastify/static')).default;
        const injectScript = opts.injectHtmlConfig
            ? runtimeConfigScript(opts.injectHtmlConfig)
            : null;
        // SPA fallback (not-found handler below) instead of wildcard; hashed
        // build output is immutable, everything else revalidates.
        app.register(fastifyStatic, webStaticOptions(opts.staticDir));
        if (opts.brandAssetsDir) {
            app.register(fastifyStatic, { root: opts.brandAssetsDir, prefix: '/brand/', decorateReply: false, maxAge: 3_600_000 });
        }
        const brand = readHtmlBrand(opts.injectHtmlConfig);
        // B-825: runtime config + brand injection, and the CSP / security headers of every HTML document.
        app.addHook('onSend', webDocumentOnSend({ injectScript, brand, serverUrl: opts.injectHtmlConfig?.serverUrl, relayOrigins: relays.candidates.map((relay) => relay.url), cspMode: parseCspMode(process.env.CSP_MODE) }));
        app.setNotFoundHandler(spaFallback(opts.staticDir, injectScript, brand));
    }

    // Socket.IO and release-admin routes must be registered before Fastify
    // starts listening. Candidate readiness therefore cannot race route setup.
    await startSocket(typed, opts.staticDir);

    // Start HTTP
    const port = opts.port ?? (process.env.PORT ? parseInt(process.env.PORT, 10) : 3005);
    const host = opts.host ?? '0.0.0.0';
    await app.listen({ port, host });
    onShutdown('api', async () => {
        await app.close();
    });

    // End
    log(`API ready on http://${host}:${port}`);
    return { port, host };
}
