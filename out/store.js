"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ReviewStore = void 0;
exports.commentBodyForSend = commentBodyForSend;
const vscode = require("vscode");
const WORKSPACE_STATE_KEY = "codeReviewSidebarState";
const GLOBAL_STATE_KEY = "codeReviewSidebarState.global";
/**
 * Single source of truth for review state. Wraps `globalState` so the
 * tree view, comments controller, editor hints, and send pipeline all
 * read/write through one object and observe the same change events.
 */
class ReviewStore {
    constructor(context) {
        this.context = context;
        this.listeners = new Set();
        const globalState = context.globalState.get(GLOBAL_STATE_KEY);
        const workspaceState = context.workspaceState.get(WORKSPACE_STATE_KEY);
        const raw = globalState ?? workspaceState ?? { pending: [], reviews: [] };
        this.state = migrateState(raw);
        if (!globalState) {
            void context.globalState.update(GLOBAL_STATE_KEY, this.state);
        }
    }
    getState() {
        return this.state;
    }
    getPending() {
        return this.state.pending;
    }
    /** Active (status === "pending") only. Used by the tree view and the send pipeline. */
    getActivePending() {
        return this.state.pending.filter((c) => c.status === "pending");
    }
    findById(id) {
        return (this.state.pending.find((c) => c.id === id) ??
            this.state.reviews.flatMap((b) => b.comments).find((c) => c.id === id));
    }
    onDidChange(listener) {
        this.listeners.add(listener);
        return new vscode.Disposable(() => this.listeners.delete(listener));
    }
    async update(mutator) {
        mutator(this.state);
        await this.context.globalState.update(GLOBAL_STATE_KEY, this.state);
        for (const listener of this.listeners) {
            try {
                listener();
            }
            catch {
                // Listeners must never throw; swallow to keep state consistent.
            }
        }
    }
}
exports.ReviewStore = ReviewStore;
function migrateState(raw) {
    return {
        pending: (raw.pending ?? []).map(migrateComment),
        reviews: (raw.reviews ?? []).map((batch) => ({
            ...batch,
            comments: (batch.comments ?? []).map(migrateComment),
        })),
    };
}
/**
 * Promote legacy `{ comment: string }` shape to `{ messages: [...] }` and
 * default `status` to "pending". The legacy field is preserved so older
 * extension versions installed alongside this one keep working.
 */
function migrateComment(c) {
    if (c.messages && c.messages.length > 0) {
        return { ...c, status: c.status ?? "pending" };
    }
    const seedBody = (c.comment ?? "").trim();
    const messages = seedBody
        ? [
            {
                id: `${c.id}-m0`,
                author: "You",
                body: seedBody,
                createdAt: c.createdAt,
            },
        ]
        : [];
    return { ...c, messages, status: c.status ?? "pending" };
}
/** Concatenates messages into the format the send pipeline appends per comment. */
function commentBodyForSend(comment) {
    if (!comment.messages.length) {
        return (comment.comment ?? "").trim();
    }
    if (comment.messages.length === 1) {
        return comment.messages[0].body.trim();
    }
    return comment.messages
        .map((m, idx) => (idx === 0 ? m.body.trim() : `↳ ${m.author}: ${m.body.trim()}`))
        .join("\n");
}
//# sourceMappingURL=store.js.map