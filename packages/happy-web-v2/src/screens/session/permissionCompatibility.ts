export type PendingPermissionCompatibility = {
    tool: string;
    kind?: 'tool' | 'elicitation' | 'user_dialog';
    permissionSuggestions?: unknown[];
};

export type SessionApprovalPolicy = {
    visible: boolean;
    /** Legacy CLI contract. Modern CLI uses its saved SDK suggestions. */
    allowedTools?: string[];
};

export function sessionApprovalPolicy(request: PendingPermissionCompatibility, mutable: boolean): SessionApprovalPolicy {
    // Old CLIs predate `kind` and `permissionSuggestions`. Keep the exact
    // legacy Web behavior so users do not lose approve-for-session merely
    // because only the hosted Web client updated.
    if (request.kind === undefined) {
        return mutable
            ? { visible: true, allowedTools: [request.tool] }
            : { visible: false };
    }

    // Modern CLIs own the exact SDK permission update. Never reconstruct it
    // from a tool name, and never expose this action for blocking dialogs.
    if (request.kind === 'tool' && (request.permissionSuggestions?.length ?? 0) > 0) {
        return { visible: true };
    }
    return { visible: false };
}
