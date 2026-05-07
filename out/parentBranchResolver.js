"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ParentBranchResolver = void 0;
const vscode = require("vscode");
const node_child_process_1 = require("node:child_process");
const gitTypes_1 = require("./gitTypes");
const PER_BRANCH_KEY = "codeReviewParent";
const GRAPHITE_KEY = "gtParentBranchName";
class ParentBranchResolver {
    /**
     * Resolves the parent ref for the repo containing `fileUri`.
     *
     * Lookup order, highest precedence first:
     *   1. `git config branch.<current>.codeReviewParent`  ← per-branch override
     *   2. `git config branch.<current>.gtParentBranchName` (Graphite metadata)
     *   3. Workspace setting `codeReview.parentBranch` (folder-scoped, useful for non-stacked repos)
     *   4. `origin/HEAD` symbolic ref (the default branch)
     *   5. Fallback: `main`
     */
    async resolve(fileUri) {
        const git = await (0, gitTypes_1.getGitApi)();
        if (!git) {
            return undefined;
        }
        const repo = git.getRepository(fileUri);
        if (!repo) {
            return undefined;
        }
        const branchName = repo.state.HEAD?.name ?? "HEAD";
        const repoRoot = repo.rootUri.fsPath;
        let parentRef;
        let source = "fallback";
        const branchOverride = await safeGetConfig(repo, `branch.${branchName}.${PER_BRANCH_KEY}`);
        if (branchOverride) {
            parentRef = branchOverride;
            source = "branchConfig";
        }
        if (!parentRef) {
            const gtParent = await safeGetConfig(repo, `branch.${branchName}.${GRAPHITE_KEY}`);
            if (gtParent) {
                parentRef = gtParent;
                source = "graphite";
            }
        }
        if (!parentRef) {
            const cfgOverride = vscode.workspace
                .getConfiguration("codeReview", fileUri)
                .get("parentBranch");
            if (cfgOverride && cfgOverride.trim().length > 0) {
                parentRef = cfgOverride.trim();
                source = "workspaceSetting";
            }
        }
        if (!parentRef) {
            const originHead = resolveOriginHead(repoRoot);
            if (originHead) {
                parentRef = originHead;
                source = "originHead";
            }
        }
        if (!parentRef) {
            parentRef = "main";
            source = "fallback";
        }
        const mergeBaseSha = await this.computeMergeBase(repo, repoRoot, parentRef);
        if (!mergeBaseSha) {
            return undefined;
        }
        return { repoRoot, branchName, parentRef, mergeBaseSha, source };
    }
    /** Persists `branch.<current>.codeReviewParent = <ref>` so subsequent diffs use it. */
    async setParentForCurrentBranch(fileUri, parentRef) {
        const git = await (0, gitTypes_1.getGitApi)();
        if (!git) {
            return false;
        }
        const repo = git.getRepository(fileUri);
        if (!repo) {
            return false;
        }
        const branchName = repo.state.HEAD?.name;
        if (!branchName) {
            return false;
        }
        try {
            await repo.setConfig(`branch.${branchName}.${PER_BRANCH_KEY}`, parentRef);
            return true;
        }
        catch {
            return false;
        }
    }
    async computeMergeBase(repo, repoRoot, parentRef) {
        try {
            const sha = await repo.getMergeBase("HEAD", parentRef);
            if (sha) {
                return sha;
            }
        }
        catch {
            // Fall through to CLI.
        }
        try {
            return (0, node_child_process_1.execFileSync)("git", ["merge-base", "HEAD", parentRef], {
                cwd: repoRoot,
                stdio: ["ignore", "pipe", "ignore"],
                encoding: "utf8",
            }).trim();
        }
        catch {
            return undefined;
        }
    }
}
exports.ParentBranchResolver = ParentBranchResolver;
async function safeGetConfig(repo, key) {
    try {
        const value = await repo.getConfig(key);
        return value && value.trim().length > 0 ? value.trim() : undefined;
    }
    catch {
        return undefined;
    }
}
function resolveOriginHead(repoRoot) {
    try {
        const ref = (0, node_child_process_1.execFileSync)("git", ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], {
            cwd: repoRoot,
            stdio: ["ignore", "pipe", "ignore"],
            encoding: "utf8",
        }).trim();
        return ref || undefined;
    }
    catch {
        return undefined;
    }
}
//# sourceMappingURL=parentBranchResolver.js.map