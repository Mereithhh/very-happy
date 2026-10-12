/**
 * B-555 wrapper side: turn raw provider frames into reports and forward them
 * to the local daemon only when something a viewer would notice changed.
 * Never throws — rate limits are advisory and must not disturb a turn.
 */
import { logger } from '@/ui/logger';
import { reportRateLimitsToDaemon } from '@/daemon/controlClient';
import {
    fromClaudeRateLimitInfo,
    fromCodexRateLimits,
    rateLimitReportSignature,
    RATE_LIMIT_OBSERVED_REFRESH_MS,
    type RateLimitProvider,
    type RateLimitReport,
} from './rateLimitWindows';

export type RateLimitReporter = {
    observeClaude(rateLimitInfo: unknown): void;
    observeCodex(snapshot: unknown): void;
};

export function createRateLimitReporter(
    send: (report: RateLimitReport) => void,
    now: () => number = Date.now,
): RateLimitReporter {
    const last = new Map<RateLimitProvider, { signature: string; at: number }>();

    const forward = (report: RateLimitReport | null) => {
        if (!report) return;
        const signature = rateLimitReportSignature(report);
        const prior = last.get(report.provider);
        // Unchanged numbers are re-sent only after the refresh interval, so the
        // daemon can keep `observedAt` honest without a write per frame.
        if (prior && prior.signature === signature && report.observedAt - prior.at < RATE_LIMIT_OBSERVED_REFRESH_MS) return;
        last.set(report.provider, { signature, at: report.observedAt });
        try {
            send(report);
        } catch (error) {
            logger.debug('[rate-limits] forward failed:', error);
        }
    };

    return {
        observeClaude(rateLimitInfo) {
            try {
                forward(fromClaudeRateLimitInfo(rateLimitInfo, now()));
            } catch (error) {
                logger.debug('[rate-limits] claude frame ignored:', error);
            }
        },
        observeCodex(snapshot) {
            try {
                forward(fromCodexRateLimits(snapshot, now()));
            } catch (error) {
                logger.debug('[rate-limits] codex snapshot ignored:', error);
            }
        },
    };
}

let processReporter: RateLimitReporter | null = null;

/** One reporter per wrapper process, so dedupe survives launcher restarts. */
export function wrapperRateLimitReporter(): RateLimitReporter {
    processReporter ??= createRateLimitReporter(reportRateLimitsToDaemon);
    return processReporter;
}
