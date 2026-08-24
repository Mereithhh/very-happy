import { App } from "octokit";
import { Webhooks } from "@octokit/webhooks";
import type { EmitterWebhookEvent } from "@octokit/webhooks";
import { log } from "@/utils/log";

let app: App | null = null;
let webhooks: Webhooks | null = null;

export async function initGithub() {
    if (
        process.env.GITHUB_APP_ID &&
        process.env.GITHUB_PRIVATE_KEY &&
        process.env.GITHUB_CLIENT_ID &&
        process.env.GITHUB_CLIENT_SECRET &&
        process.env.GITHUB_REDIRECT_URI &&
        process.env.GITHUB_WEBHOOK_SECRET
    ) {
        app = new App({
            appId: process.env.GITHUB_APP_ID,
            privateKey: process.env.GITHUB_PRIVATE_KEY,
            webhooks: {
                secret: process.env.GITHUB_WEBHOOK_SECRET
            }
        });
        
        // Initialize standalone webhooks handler for type-safe event processing
        webhooks = new Webhooks({
            secret: process.env.GITHUB_WEBHOOK_SECRET
        });
        
        // Register type-safe event handlers
        registerWebhookHandlers();
    }
}

function registerWebhookHandlers() {
    if (!webhooks) return;
    
    // Type-safe handlers for specific events
    webhooks.on("push", async ({ id, name, payload }: EmitterWebhookEvent<"push">) => {
        log({ module: 'github-webhook', event: 'push' }, 'GitHub push webhook received');
    });
    
    webhooks.on("pull_request", async ({ id, name, payload }: EmitterWebhookEvent<"pull_request">) => {
        log({ module: 'github-webhook', event: 'pull_request', operation: payload.action },
            'GitHub pull-request webhook received');
    });
    
    webhooks.on("issues", async ({ id, name, payload }: EmitterWebhookEvent<"issues">) => {
        log({ module: 'github-webhook', event: 'issues', operation: payload.action },
            'GitHub issue webhook received');
    });
    
    webhooks.on(["star.created", "star.deleted"], async ({ id, name, payload }: EmitterWebhookEvent<"star.created" | "star.deleted">) => {
        const operation = payload.action === 'created' ? 'starred' : 'unstarred';
        log({ module: 'github-webhook', event: 'star', operation }, 'GitHub star webhook received');
    });
    
    webhooks.on("repository", async ({ id, name, payload }: EmitterWebhookEvent<"repository">) => {
        log({ module: 'github-webhook', event: 'repository', operation: payload.action },
            'GitHub repository webhook received');
    });
    
    // Catch-all for unhandled events
    webhooks.onAny(async ({ id, name, payload }: EmitterWebhookEvent) => {
        log({ module: 'github-webhook', event: name as string }, 'GitHub webhook received');
    });
    
    webhooks.onError((error: any) => {
        log({ module: 'github-webhook', level: 'error', event: error.event?.name, error },
            'GitHub webhook handler failed');
    });
}

export function getWebhooks(): Webhooks | null {
    return webhooks;
}

export function getApp(): App | null {
    return app;
}
