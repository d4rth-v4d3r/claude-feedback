"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ParentBranchResolver = void 0;
exports.gitWorktreeRootForUri = gitWorktreeRootForUri;
const vscode = require("vscode");
const path = require("node:path");
const fs = require("node:fs");
const node_child_process_1 = require("node:child_process");
const node_util_1 = require("node:util");
const gitTypes_1 = require("./gitTypes");
const execFileAsync = (0, node_util_1.promisify)(node_child_process_1.execFile);
const PER_BRANCH_KEY = "codeReviewParent";
const GRAPHITE_KEY = "gtParentBranchName";
const WORKTREE_PARENT_STATE_KEY = "codeReview.worktreeParents.v1";
const SOURCE_RANK = {
    worktreeOverride: 100,
    branchConfig: 90,
    gitTown: 80,
    githubRefined: 85,
    graphite: 75,
    upstream: 50,
    workspaceSetting: 40,
    originHead: 20,
    fallback: 10,
};
class ParentBranchResolver {
    constructor(workspaceState) {
        this.workspaceState = workspaceState;
        this.changeEmitter = new vscode.EventEmitter();
        this.onDidChangeParents = this.changeEmitter.event;
    }
    dispose() {
        this.changeEmitter.dispose();
    }
    fireParentsChanged() {
        this.changeEmitter.fire();
    }
    getWorktreeOverride(worktreeRoot) {
        const key = normalizeWorktreeKey(worktreeRoot);
        const raw = this.readWorktreeParentMap()[key]?.trim();
        return raw?.length ? raw : undefined;
    }
    hasWorktreeOverride(worktreeRoot) {
        return !!this.getWorktreeOverride(worktreeRoot);
    }
    async setWorktreeOverride(worktreeRoot, parentRef) {
        if (!this.workspaceState) {
            return false;
        }
        const key = normalizeWorktreeKey(worktreeRoot);
        const next = { ...this.readWorktreeParentMap(), [key]: parentRef.trim() };
        await this.workspaceState.update(WORKTREE_PARENT_STATE_KEY, next);
        this.fireParentsChanged();
        return true;
    }
    async clearWorktreeOverride(worktreeRoot) {
        if (!this.workspaceState) {
            return false;
        }
        const key = normalizeWorktreeKey(worktreeRoot);
        const map = { ...this.readWorktreeParentMap() };
        if (!map[key]) {
            return false;
        }
        delete map[key];
        await this.workspaceState.update(WORKTREE_PARENT_STATE_KEY, map);
        this.fireParentsChanged();
        return true;
    }
    readWorktreeParentMap() {
        try {
            const v = this.workspaceState?.get(WORKTREE_PARENT_STATE_KEY);
            return v && typeof v === "object" ? v : {};
        }
        catch {
            return {};
        }
    }
    static formatSourceLabel(src) {
        switch (src) {
            case "worktreeOverride":
                return "VS Code override";
            case "branchConfig":
                return "git config";
            case "gitTown":
                return "Git Town";
            case "graphite":
                return "Graphite";
            case "upstream":
                return "@{upstream}";
            case "workspaceSetting":
                return "workspace setting";
            case "originHead":
                return "default branch";
            case "fallback":
                return "fallback";
            case "githubRefined":
                return "GitHub PR";
            default:
                return src;
        }
    }
    async suggestParents(uri) {
        const wt = gitWorktreeRootForUri(uri);
        if (!wt) {
            return [];
        }
        const git = await (0, gitTypes_1.getGitApi)();
        const repo = git?.getRepository(uri) ?? git?.getRepository(vscode.Uri.file(wt)) ?? undefined;
        const repoRoot = repo?.rootUri.fsPath ?? getCommonRepoRootFallback(wt) ?? wt;
        const gitCwd = wt; // git config entries (graphite/linage) can be worktree-local; read them from the checkout.
        const branchName = normalizeLocalBranchName(branchNameForRepo(repo, wt));
        const rawOrdered = dedupePreferBestTier(this.buildRawTierList(repo, uri, wt, gitCwd, branchName));
        const validated = await this.validateCandidates(repo, gitCwd, rawOrdered);
        return mergeSuggestions(validated);
    }
    async resolve(uri, options) {
        const worktreeRoot = gitWorktreeRootForUri(uri);
        if (!worktreeRoot) {
            return undefined;
        }
        const git = await (0, gitTypes_1.getGitApi)();
        const repo = git?.getRepository(uri) ?? git?.getRepository(vscode.Uri.file(worktreeRoot)) ?? undefined;
        const repoRoot = repo?.rootUri.fsPath ?? getCommonRepoRootFallback(worktreeRoot) ?? worktreeRoot;
        const gitCwd = worktreeRoot;
        const branchName = normalizeLocalBranchName(branchNameForRepo(repo, worktreeRoot));
        const rawOrdered = dedupePreferBestTier(this.buildRawTierList(repo, uri, worktreeRoot, gitCwd, branchName));
        const validated = await this.validateCandidates(repo, gitCwd, rawOrdered);
        const best = validated[0];
        if (!best) {
            return undefined;
        }
        let source = best.source;
        let parentRef = best.ref;
        let mergeBaseSha = best.mergeBaseSha;
        const wsFolder = vscode.workspace.getWorkspaceFolder(uri);
        const ghMode = vscode.workspace
            .getConfiguration("codeReview", wsFolder ?? uri)
            .get("ghParentBranch", "off");
        let ghNote;
        if (!options?.skipGh && branchName !== "HEAD" && ghMode !== "off") {
            const ghBase = await queryGhPrBase(gitCwd, branchName);
            // "refineGeneric" should mean: "if we likely picked the PR's generic/default base (even if a tool said it)",
            // then let GitHub correct us to the PR base.
            const originSym = resolveOriginHead(gitCwd);
            const normalizedOriginSym = originSym
                ? preferLocalBranchOverOriginRemote(gitCwd, originSym, headBranchPreferLocal(branchName))
                : undefined;
            const normalizedChosenParent = preferLocalBranchOverOriginRemote(gitCwd, parentRef, headBranchPreferLocal(branchName));
            const generic = source === "originHead" ||
                source === "fallback" ||
                normalizedChosenParent === "main" ||
                (normalizedOriginSym ? normalizedChosenParent === normalizedOriginSym : false);
            if (ghMode === "refineGeneric" && ghBase && generic) {
                const refined = await this.tryGhParentRef(repo, gitCwd, ghBase, branchName);
                if (refined) {
                    parentRef = refined.parentRef;
                    mergeBaseSha = refined.mergeBaseSha;
                    source = "githubRefined";
                }
            }
            if (ghMode === "annotate" && ghBase) {
                const mbGh = await this.pickFirstWorkingMergeBase(repo, gitCwd, githubBaseRefCandidates(ghBase));
                ghNote =
                    !mbGh
                        ? `GitHub PR base "${ghBase}" is not reachable for merge-base from this HEAD`
                        : mbGh.sha !== mergeBaseSha
                            ? `GitHub PR base ${ghBase} → merge-base ${mbGh.sha.slice(0, 7)} (active parent uses ${mergeBaseSha.slice(0, 7)})`
                            : `GitHub PR base ${ghBase} matches merge-base`;
            }
        }
        return {
            repoRoot,
            worktreeRoot,
            branchName,
            parentRef: preferLocalBranchOverOriginRemote(gitCwd, parentRef, headBranchPreferLocal(branchName)),
            mergeBaseSha,
            source,
            ghNote,
        };
    }
    /** Try `origin/<branch>` then the bare branch name for PR base from GitHub. */
    async tryGhParentRef(repo, repoRoot, ghBaseBranch, checkoutBranch) {
        const refs = githubBaseRefCandidates(ghBaseBranch);
        const hit = await this.pickFirstWorkingMergeBase(repo, repoRoot, refs);
        if (!hit) {
            return undefined;
        }
        return {
            parentRef: preferLocalBranchOverOriginRemote(repoRoot, hit.ref, headBranchPreferLocal(checkoutBranch)),
            mergeBaseSha: hit.sha,
        };
    }
    async pickFirstWorkingMergeBase(repo, repoRoot, refs) {
        for (const r of refs) {
            const sha = await this.computeMergeBaseOnly(repo, repoRoot, r);
            if (sha) {
                return { ref: r, sha };
            }
        }
        return undefined;
    }
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
            this.fireParentsChanged();
            return true;
        }
        catch {
            return false;
        }
    }
    buildRawTierList(repo, uri, worktreeRoot, repoRoot, branchName) {
        const tiers = [];
        const checkout = headBranchPreferLocal(branchName);
        const wtOv = this.getWorktreeOverride(worktreeRoot);
        if (wtOv) {
            tiers.push({ ref: preferLocalBranchOverOriginRemote(repoRoot, wtOv, checkout), source: "worktreeOverride" });
        }
        if (branchName && branchName !== "HEAD") {
            const ov = execGitConfig(repoRoot, `branch.${branchName}.${PER_BRANCH_KEY}`);
            if (ov) {
                tiers.push({ ref: preferLocalBranchOverOriginRemote(repoRoot, ov, checkout), source: "branchConfig" });
            }
            const gtp = gitTownParent(repoRoot, branchName);
            if (gtp) {
                tiers.push({ ref: preferLocalBranchOverOriginRemote(repoRoot, gtp, checkout), source: "gitTown" });
            }
            const gtParentMeta = graphiteParentBranch(repoRoot, branchName);
            if (gtParentMeta) {
                tiers.push({
                    ref: preferLocalBranchOverOriginRemote(repoRoot, gtParentMeta, checkout),
                    source: "graphite",
                });
            }
        }
        const originSym = resolveOriginHead(repoRoot);
        if (branchName !== "HEAD") {
            const up = tryUpstreamDistinct(repoRoot, originSym, branchName);
            if (up) {
                tiers.push({ ref: preferLocalBranchOverOriginRemote(repoRoot, up, checkout), source: "upstream" });
            }
        }
        const wsFolder = vscode.workspace.getWorkspaceFolder(uri);
        const folderParent = vscode.workspace
            .getConfiguration("codeReview", wsFolder ?? uri)
            .get("parentBranch") ?? "";
        if (folderParent.trim()) {
            tiers.push({
                ref: preferLocalBranchOverOriginRemote(repoRoot, folderParent.trim(), checkout),
                source: "workspaceSetting",
            });
        }
        if (originSym) {
            tiers.push({ ref: preferLocalBranchOverOriginRemote(repoRoot, originSym, checkout), source: "originHead" });
        }
        tiers.push({ ref: "main", source: "fallback" });
        return tiers;
    }
    async validateCandidates(repo, repoRoot, ordered) {
        const out = [];
        const seenMb = new Set();
        for (const raw of ordered) {
            const sha = await this.computeMergeBaseOnly(repo, repoRoot, raw.ref);
            if (!sha || seenMb.has(sha)) {
                continue;
            }
            seenMb.add(sha);
            out.push({ ...raw, mergeBaseSha: sha });
        }
        return out;
    }
    async computeMergeBaseOnly(repo, repoRoot, parentRef) {
        try {
            const sha = await repo?.getMergeBase("HEAD", parentRef);
            if (sha) {
                return sha;
            }
        }
        catch {
            //
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
function normalizeWorktreeKey(root) {
    return path.normalize(root);
}
function gitWorktreeRootForUri(uri) {
    if (uri.scheme !== "file") {
        return undefined;
    }
    let cwd = uri.fsPath;
    try {
        if (fs.existsSync(uri.fsPath) && fs.statSync(uri.fsPath).isDirectory()) {
            cwd = uri.fsPath;
        }
        else {
            cwd = path.dirname(uri.fsPath);
        }
    }
    catch {
        cwd = path.dirname(uri.fsPath);
    }
    try {
        return path.normalize((0, node_child_process_1.execFileSync)("git", ["rev-parse", "--show-toplevel"], {
            cwd,
            encoding: "utf8",
            stdio: ["ignore", "pipe", "ignore"],
        }).trim());
    }
    catch {
        return undefined;
    }
}
function execGitConfig(repoRoot, key) {
    try {
        const v = (0, node_child_process_1.execFileSync)("git", ["config", "--get", key], {
            cwd: repoRoot,
            stdio: ["ignore", "pipe", "ignore"],
            encoding: "utf8",
        }).trim();
        return v?.length ? v : undefined;
    }
    catch {
        return undefined;
    }
}
function branchNameForRepo(repo, worktreeRoot) {
    const n = repo?.state.HEAD?.name;
    if (n && n !== "HEAD") {
        return n;
    }
    try {
        const b = (0, node_child_process_1.execFileSync)("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
            cwd: worktreeRoot,
            stdio: ["ignore", "pipe", "ignore"],
            encoding: "utf8",
        }).trim();
        return b?.length ? b : "HEAD";
    }
    catch {
        return "HEAD";
    }
}
/**
 * Graphite keys are stored as `branch.<branchName>.*`, where `<branchName>` is typically the local checkout name.
 * Sometimes VS Code / git APIs report `origin/<branch>` — normalize to the local stem so we reliably find config.
 */
function normalizeLocalBranchName(branchName) {
    const t = branchName.trim();
    if (!t || t === "HEAD") {
        return t;
    }
    return t
        .replace(/^refs\/heads\//, "")
        .replace(/^refs\/remotes\/origin\//, "")
        .replace(/^origin\//, "");
}
function getCommonRepoRootFallback(worktreeRoot) {
    try {
        const commonRaw = (0, node_child_process_1.execFileSync)("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], {
            cwd: worktreeRoot,
            stdio: ["ignore", "pipe", "ignore"],
            encoding: "utf8",
        }).trim();
        if (!commonRaw) {
            return undefined;
        }
        return path.normalize(path.dirname(path.resolve(commonRaw)));
    }
    catch {
        return undefined;
    }
}
/** Git Town: `git-town-branch.<branch>.parent` subsection. Falls back to scanning all lineage keys. */
function gitTownParent(repoRoot, branchName) {
    if (!branchName || branchName === "HEAD") {
        return undefined;
    }
    try {
        const direct = (0, node_child_process_1.execFileSync)("git", ["config", "--get", `git-town-branch.${branchName}.parent`], {
            cwd: repoRoot,
            stdio: ["ignore", "pipe", "ignore"],
            encoding: "utf8",
        }).trim();
        if (direct) {
            return direct;
        }
    }
    catch {
        //
    }
    try {
        const raw = (0, node_child_process_1.execFileSync)("git", ["config", "--get-regexp", "^git-town-branch\\."], {
            cwd: repoRoot,
            stdio: ["ignore", "pipe", "ignore"],
            encoding: "utf8",
        }).toString();
        const re = /^git-town-branch\.(.+)\.parent$/;
        for (const line of raw.trim().split("\n").filter(Boolean)) {
            const sep = line.indexOf(" ");
            if (sep < 1) {
                continue;
            }
            const key = line.slice(0, sep);
            const val = line.slice(sep + 1).trim();
            const m = re.exec(key);
            if (!m?.[1] || m[1] !== branchName || !val.length) {
                continue;
            }
            return val;
        }
    }
    catch {
        //
    }
    return undefined;
}
/**
 * Graphite: `branch.<branchName>.gtParentBranchName` (with a scan fallback).
 *
 * In practice, branch-name inference can be slightly off (e.g. `origin/<x>` vs `<x>`),
 * so we first try the direct key, then fall back to scanning all graphite keys and
 * matching the captured branch name.
 */
function graphiteParentBranch(repoRoot, branchName) {
    if (!branchName || branchName === "HEAD") {
        return undefined;
    }
    const directKeys = [
        `branch.${branchName}.${GRAPHITE_KEY}`,
        // Some metadata writers end up keying under remote-style names.
        `branch.origin/${branchName}.${GRAPHITE_KEY}`,
        `branch.refs/remotes/origin/${branchName}.${GRAPHITE_KEY}`,
    ];
    for (const k of directKeys) {
        const direct = execGitConfig(repoRoot, k);
        if (direct) {
            return direct;
        }
    }
    try {
        // Narrow pattern: any key ending in `.gtParentBranchName` (avoids brittle `^branch\\.` regex + huge scans).
        const raw = (0, node_child_process_1.execFileSync)("git", ["config", "--get-regexp", `\\.${GRAPHITE_KEY}$`], {
            cwd: repoRoot,
            stdio: ["ignore", "pipe", "ignore"],
            encoding: "utf8",
            maxBuffer: 512 * 1024,
        }).toString();
        const re = new RegExp(`^branch\\.(.+)\\.${GRAPHITE_KEY}$`);
        for (const line of raw.trim().split("\n").filter(Boolean)) {
            const sep = line.indexOf(" ");
            if (sep < 1)
                continue;
            const key = line.slice(0, sep);
            const val = line.slice(sep + 1).trim();
            const m = re.exec(key);
            if (!m?.[1])
                continue;
            const inferredKeyBranchNormalized = normalizeLocalBranchName(m[1]);
            if (inferredKeyBranchNormalized === branchName && val.length) {
                return val;
            }
        }
    }
    catch {
        // ignore
    }
    return undefined;
}
/** Git branch name usable for “don’t treat `origin/<me>` as `<me>` merge parent” checks. */
function headBranchPreferLocal(branchName) {
    return branchName && branchName !== "HEAD" ? branchName : undefined;
}
/** `git rev-parse --abbrev-ref @{upstream}` → `remote/branch`; return the branch part (may contain `/`). */
function abbreviatedUpstreamTrackedBranchStem(abbrevRef) {
    const t = abbrevRef.trim();
    const i = t.indexOf("/");
    if (i <= 0 || i === t.length - 1) {
        return undefined;
    }
    return t.slice(i + 1);
}
/** Use @{upstream} only when it is not self-tracking (≠ PR base — that comes from Graphite / GitHub / default branch). */
function tryUpstreamDistinct(repoRoot, originHeadSymbolic, checkedOutBranchName) {
    if (!checkedOutBranchName || checkedOutBranchName === "HEAD") {
        return undefined;
    }
    try {
        (0, node_child_process_1.execFileSync)("git", ["rev-parse", "-q", "--verify", "@{upstream}"], {
            cwd: repoRoot,
            stdio: ["ignore", "pipe", "ignore"],
        });
        const abbrev = (0, node_child_process_1.execFileSync)("git", ["rev-parse", "--abbrev-ref", "@{upstream}"], {
            cwd: repoRoot,
            stdio: ["ignore", "pipe", "ignore"],
            encoding: "utf8",
        }).trim();
        const upSha = (0, node_child_process_1.execFileSync)("git", ["rev-parse", "@{upstream}"], {
            cwd: repoRoot,
            stdio: ["ignore", "pipe", "ignore"],
            encoding: "utf8",
        }).trim();
        const headSha = revParseCommitSha(repoRoot, "HEAD");
        /** Push target = your own branch tip — yields “parent = self” / empty diff vs merge-base. Never a GitHub PR base. */
        if (headSha && upSha === headSha) {
            return undefined;
        }
        const trackedStem = abbreviatedUpstreamTrackedBranchStem(abbrev);
        if (trackedStem && trackedStem === checkedOutBranchName) {
            return undefined;
        }
        try {
            if (originHeadSymbolic) {
                const defSha = (0, node_child_process_1.execFileSync)("git", ["rev-parse", originHeadSymbolic], {
                    cwd: repoRoot,
                    stdio: ["ignore", "pipe", "ignore"],
                    encoding: "utf8",
                }).trim();
                if (defSha === upSha) {
                    return undefined;
                }
            }
        }
        catch {
            //
        }
        (0, node_child_process_1.execFileSync)("git", ["merge-base", "--is-ancestor", upSha, "HEAD"], {
            cwd: repoRoot,
            stdio: ["ignore", "pipe", "ignore"],
        });
        (0, node_child_process_1.execFileSync)("git", ["merge-base", "HEAD", abbrev], {
            cwd: repoRoot,
            stdio: ["ignore", "pipe", "ignore"],
        });
        return abbrev || undefined;
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
        try {
            return (0, node_child_process_1.execFileSync)("git", ["rev-parse", "--abbrev-ref", "origin/HEAD"], {
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
/** For `gh PR base`: prefer reachable local branch tips before duplicate `origin/…` remotes (Git UI already surfaces those). */
function githubBaseRefCandidates(ghBaseBranch) {
    const raw = ghBaseBranch.trim();
    if (!raw.length) {
        return [];
    }
    let stem = raw;
    if (raw.startsWith("refs/remotes/origin/")) {
        stem = raw.slice("refs/remotes/origin/".length);
    }
    else if (raw.startsWith("origin/")) {
        stem = raw.slice("origin/".length);
    }
    const uniq = [];
    const push = (s) => {
        const z = s.trim();
        if (z.length && !uniq.includes(z)) {
            uniq.push(z);
        }
    };
    push(stem);
    push(`origin/${stem}`);
    if (raw !== stem && raw !== `origin/${stem}`) {
        push(raw);
    }
    return uniq;
}
function branchNameUnderOrigin(ref) {
    const tr = ref.trim();
    const mRemote = /^refs\/remotes\/origin\/(.+)$/.exec(tr);
    if (mRemote?.[1] && mRemote[1] !== "HEAD") {
        return mRemote[1];
    }
    const mShort = /^origin\/(.+)$/.exec(tr);
    if (mShort?.[1] && mShort[1] !== "HEAD") {
        return mShort[1];
    }
    return undefined;
}
function revParseCommitSha(repoRoot, ref) {
    try {
        const sha = (0, node_child_process_1.execFileSync)("git", ["rev-parse", `${ref}^{commit}`], {
            cwd: repoRoot,
            stdio: ["ignore", "pipe", "ignore"],
            encoding: "utf8",
        }).trim();
        return sha.length ? sha : undefined;
    }
    catch {
        return undefined;
    }
}
/**
 * Prefer `feat/foo` over `origin/feat/foo` when both tips match — stack parents stay human-readable.
 * Never rename to the checked-out branch name (that was `origin/<self>` and implied an empty review diff).
 */
function preferLocalBranchOverOriginRemote(repoRoot, ref, checkedOutBranch) {
    const t = ref.trim();
    const base = branchNameUnderOrigin(t);
    if (!base || base === "HEAD") {
        return t;
    }
    if (checkedOutBranch && base === checkedOutBranch) {
        return t;
    }
    const remoteTip = revParseCommitSha(repoRoot, t);
    if (!remoteTip) {
        return t;
    }
    try {
        (0, node_child_process_1.execFileSync)("git", ["show-ref", "--verify", "--quiet", `refs/heads/${base}`], {
            cwd: repoRoot,
            stdio: ["ignore", "pipe", "pipe"],
        });
    }
    catch {
        return t;
    }
    const localTip = revParseCommitSha(repoRoot, base);
    if (!localTip || localTip !== remoteTip) {
        return t;
    }
    return base;
}
function dedupePreferBestTier(order) {
    const best = new Map();
    for (const c of order) {
        const k = c.ref.trim();
        const prev = best.get(k);
        if (!prev || SOURCE_RANK[c.source] > SOURCE_RANK[prev.source]) {
            best.set(k, c);
        }
    }
    const seen = new Set();
    const out = [];
    for (const c of order) {
        const k = c.ref.trim();
        if (seen.has(k)) {
            continue;
        }
        seen.add(k);
        out.push(best.get(k));
    }
    return out;
}
function mergeSuggestions(validated) {
    const byRef = new Map();
    const orderRef = [];
    for (const v of validated) {
        if (!byRef.has(v.ref)) {
            orderRef.push(v.ref);
            byRef.set(v.ref, []);
        }
        const list = byRef.get(v.ref);
        if (!list.includes(v.source)) {
            list.push(v.source);
        }
    }
    for (const [, list] of byRef) {
        list.sort((a, b) => SOURCE_RANK[b] - SOURCE_RANK[a]);
    }
    return orderRef.map((ref) => ({ ref, sources: byRef.get(ref) ?? [] }));
}
async function queryGhPrBase(repoRoot, headBranchName) {
    try {
        const { stdout } = await execFileAsync("gh", ["pr", "view", headBranchName, "--json", "baseRefName", "-q", ".baseRefName"], {
            cwd: repoRoot,
            encoding: "utf8",
            timeout: 10000,
            maxBuffer: 256 * 1024,
            env: {
                ...process.env,
                GH_PROMPT_DISABLED: "1",
            },
        });
        const t = stdout.trim();
        return t?.length ? t : undefined;
    }
    catch {
        return undefined;
    }
}
//# sourceMappingURL=parentBranchResolver.js.map