import { log } from "@/utils/log";
import { Fastify } from "../types";
import { FastifyError } from "fastify";
import { safeRequestPath } from './enableAuthentication';

export interface EnableErrorHandlersOptions {
    skipNotFoundHandler?: boolean;
}

export function enableErrorHandlers(app: Fastify, options: EnableErrorHandlersOptions = {}) {
    // Global error handler
    app.setErrorHandler(async (error: FastifyError, request, reply) => {
        const method = request.method;
        const url = safeRequestPath(request.url);
        const ip = request.ip || 'unknown';

        // Log the error with comprehensive context
        log({
            module: 'fastify-error',
            level: 'error',
            method,
            url,
            hasAuthorization: !!request.headers.authorization,
            contentType: request.headers['content-type'],
            ip,
            statusCode: error.statusCode || 500,
            errorCode: error.code,
            error,
        }, 'Unhandled request error');

        // Return appropriate error response
        const statusCode = error.statusCode || 500;

        if (statusCode >= 500) {
            // Internal server errors - don't expose details
            return reply.code(statusCode).send({
                error: 'Internal Server Error',
                message: 'An unexpected error occurred',
                statusCode
            });
        } else {
            // Client errors - can expose more details
            return reply.code(statusCode).send({
                error: error.name || 'Error',
                message: error.message || 'An error occurred',
                statusCode
            });
        }
    });

    // Catch-all route for debugging 404s. Skipped when caller will register
    // its own (e.g. SPA fallback for self-hosted webapp).
    if (!options.skipNotFoundHandler) {
        app.setNotFoundHandler((request, reply) => {
            const path = safeRequestPath(request.url);
            log({ module: '404-handler' }, notFoundLog(request.method, path, !!request.headers.authorization));
            reply.code(404).send({ error: 'Not found', path, method: request.method });
        });
    }

    // Error hook for additional logging
    app.addHook('onError', async (request, reply, error) => {
        const method = request.method;
        const url = safeRequestPath(request.url);
        const duration = (Date.now() - (request.startTime || Date.now())) / 1000;

        log({
            module: 'fastify-hook-error',
            level: 'error',
            method,
            url,
            duration,
            statusCode: reply.statusCode || error.statusCode || 500,
            errorName: error.name,
            errorCode: error.code,
            error,
        }, 'Request error');
    });

    // Handle uncaught exceptions in routes
    app.addHook('preHandler', async (request, reply) => {
        // Store original reply.send to catch errors in response serialization
        const originalSend = reply.send.bind(reply);
        reply.send = function (payload: any) {
            try {
                return originalSend(payload);
            } catch (error: any) {
                log({
                    module: 'fastify-serialization-error',
                    level: 'error',
                    method: request.method,
                    url: safeRequestPath(request.url),
                    error,
                }, 'Response serialization error');
                throw error;
            }
        };
    });
}

export function notFoundLog(method: string, path: string, hasAuthorization: boolean): string {
    return `404 - Method: ${method}, Path: ${path}, has authorization: ${hasAuthorization}`;
}
