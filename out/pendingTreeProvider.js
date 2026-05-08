"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.PendingTreeProvider = exports.FileNode = exports.DirectoryNode = exports.WorktreeNode = exports.RepoNode = void 0;
const vscode = require("vscode");
const path = require("node:path");
const node_child_process_1 = require("node:child_process");
const gitTypes_1 = require("./gitTypes");
class RepoNode {
    constructor(repoKey, repoName, repoPath, 
    /** Total pending comments in this repo (visible worktrees). */
    commentCount, 
    /** Distinct files with pending comments across worktrees. */
    changedFileCount, worktrees) {
        this.repoKey = repoKey;
        this.repoName = repoName;
        this.repoPath = repoPath;
        this.commentCount = commentCount;
        this.changedFileCount = changedFileCount;
        this.worktrees = worktrees;
        this.kind = "repo";
    }
}
exports.RepoNode = RepoNode;
class WorktreeNode {
    constructor(worktreeKey, worktreeName, branchName, workspaceFolderPath, isRootWorktree, 
    /** Files listed in the tree (only files with pending comments). */
    changedFileCount, 
    /** Top-level children of the worktree root: directories and any files at the root. */
    children) {
        this.worktreeKey = worktreeKey;
        this.worktreeName = worktreeName;
        this.branchName = branchName;
        this.workspaceFolderPath = workspaceFolderPath;
        this.isRootWorktree = isRootWorktree;
        this.changedFileCount = changedFileCount;
        this.children = children;
        this.kind = "worktree";
    }
}
exports.WorktreeNode = WorktreeNode;
class DirectoryNode {
    constructor(
    /** Stable id segment: normalized git worktree root (unique per checkout). */
    worktreeKey, 
    /** Display label, e.g. "packages/restaurant-ui" when single-child chains are compacted. */
    label, 
    /** Path relative to the worktree root, used as the stable tree id. */
    relativePath, commentCount, children) {
        this.worktreeKey = worktreeKey;
        this.label = label;
        this.relativePath = relativePath;
        this.commentCount = commentCount;
        this.children = children;
        this.kind = "directory";
    }
}
exports.DirectoryNode = DirectoryNode;
class FileNode {
    constructor(
    /** Normalized worktree root; pairs with relativePath for stable TreeItem.id. */
    worktreeKey, filePath, 
    /** Path relative to the worktree root. */
    relativePath, count, workspaceFolderPath) {
        this.worktreeKey = worktreeKey;
        this.filePath = filePath;
        this.relativePath = relativePath;
        this.count = count;
        this.workspaceFolderPath = workspaceFolderPath;
        this.kind = "file";
    }
}
exports.FileNode = FileNode;
class PendingTreeProvider {
    constructor(store) {
        this.store = store;
        this.emitter = new vscode.EventEmitter();
        this.onDidChangeTreeData = this.emitter.event;
        this.subscriptions = [];
        this.subscriptions.push(this.store.onDidChange(() => this.scheduleTreeRefresh()));
        this.subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(() => this.scheduleTreeRefresh()));
        this.subscriptions.push(vscode.workspace.onDidChangeConfiguration((e) => {
            if (e.affectsConfiguration("codeReview")) {
                this.scheduleTreeRefresh();
            }
        }));
        this.subscriptions.push(vscode.workspace.onDidSaveTextDocument((doc) => {
            if (doc.uri.scheme === "file") {
                this.scheduleTreeRefresh();
            }
        }));
        void this.attachGitRefresh();
    }
    scheduleTreeRefresh() {
        if (this.refreshDebounceTimer !== undefined) {
            clearTimeout(this.refreshDebounceTimer);
        }
        this.refreshDebounceTimer = setTimeout(() => {
            this.refreshDebounceTimer = undefined;
            this.emitter.fire();
        }, PendingTreeProvider.REFRESH_DEBOUNCE_MS);
    }
    dispose() {
        if (this.refreshDebounceTimer !== undefined) {
            clearTimeout(this.refreshDebounceTimer);
            this.refreshDebounceTimer = undefined;
        }
        vscode.Disposable.from(...this.subscriptions).dispose();
        this.emitter.dispose();
    }
    getTreeItem(element) {
        switch (element.kind) {
            case "repo":
                return repoTreeItem(element);
            case "worktree":
                return worktreeTreeItem(element);
            case "directory":
                return directoryTreeItem(element);
            case "file":
                return fileTreeItem(element);
        }
    }
    getChildren(element) {
        if (!element) {
            return this.buildRepoNodes();
        }
        if (element.kind === "repo") {
            return element.worktrees;
        }
        if (element.kind === "worktree") {
            return element.children;
        }
        if (element.kind === "directory") {
            return element.children;
        }
        return [];
    }
    async attachGitRefresh() {
        const git = await (0, gitTypes_1.getGitApi)();
        if (!git) {
            return;
        }
        const wireRepo = (repo) => {
            if (repo.onDidChangeState) {
                this.subscriptions.push(repo.onDidChangeState(() => this.scheduleTreeRefresh()));
            }
        };
        for (const repo of git.repositories) {
            wireRepo(repo);
        }
        if (git.onDidOpenRepository) {
            this.subscriptions.push(git.onDidOpenRepository((repo) => {
                wireRepo(repo);
                this.scheduleTreeRefresh();
            }));
        }
    }
    async buildRepoNodes() {
        const visibleFolderPaths = new Set((vscode.workspace.workspaceFolders ?? []).map((f) => path.normalize(f.uri.fsPath)));
        const pendingAll = this.store
            .getActivePending()
            .filter((c) => visibleFolderPaths.has(path.normalize(c.workspaceFolderPath)));
        const compactFolders = vscode.workspace
            .getConfiguration("codeReview")
            .get("compactFolders", true);
        const byWorktreeRoot = new Map();
        const ensureAgg = (worktreeRoot, workspaceFolderPath) => {
            const normalizedRoot = path.normalize(worktreeRoot);
            let agg = byWorktreeRoot.get(normalizedRoot);
            if (agg) {
                return agg;
            }
            const id = getRepoIdentity(normalizedRoot);
            agg = {
                worktreeRoot: normalizedRoot,
                workspaceFolderPath,
                repoRoot: id.repoRoot,
                repoName: id.repoName,
                worktreeName: id.worktreeName,
                branchName: getBranchName(normalizedRoot),
                comments: [],
            };
            byWorktreeRoot.set(normalizedRoot, agg);
            return agg;
        };
        for (const folder of vscode.workspace.workspaceFolders ?? []) {
            const wt = tryGetWorktreeRoot(folder.uri.fsPath);
            if (!wt) {
                continue;
            }
            ensureAgg(wt, folder.uri.fsPath);
        }
        for (const c of pendingAll) {
            const wt = tryGetWorktreeRoot(path.dirname(c.filePath));
            if (!wt) {
                continue;
            }
            if (!visibleFolderPaths.has(path.normalize(c.workspaceFolderPath))) {
                continue;
            }
            const agg = ensureAgg(wt, c.workspaceFolderPath);
            if (agg) {
                agg.comments.push(c);
            }
        }
        const repoMap = new Map();
        for (const agg of byWorktreeRoot.values()) {
            const repoKey = agg.repoRoot;
            const repoEntry = repoMap.get(repoKey) ??
                {
                    repoKey,
                    repoName: agg.repoName,
                    repoPath: agg.repoRoot,
                    commentCount: 0,
                    changedFileCount: 0,
                    worktreeMap: new Map(),
                };
            repoEntry.worktreeMap.set(agg.worktreeRoot, agg);
            repoMap.set(repoKey, repoEntry);
        }
        for (const c of pendingAll) {
            const repoEntry = repoMap.get(getRepoIdentityFromFile(c.filePath).repoRoot);
            if (repoEntry) {
                repoEntry.commentCount += 1;
            }
        }
        const repos = [];
        for (const repo of repoMap.values()) {
            const worktrees = [];
            let repoChangedFiles = 0;
            for (const w of repo.worktreeMap.values()) {
                const relPaths = new Set();
                for (const c of w.comments) {
                    relPaths.add(normRelPath(c.relativePath));
                }
                const fileInfos = new Map();
                for (const rel of relPaths) {
                    const abs = path.join(w.worktreeRoot, ...rel.split("/").filter(Boolean));
                    const count = w.comments.filter((c) => normRelPath(c.relativePath) === rel).length;
                    fileInfos.set(rel, { filePath: abs, count });
                }
                const dirEntry = buildDirEntryFromFiles(fileInfos);
                const worktreeKey = path.normalize(w.worktreeRoot);
                const children = toTreeChildren(dirEntry, "", worktreeKey, w.workspaceFolderPath, compactFolders);
                const changedFileCount = relPaths.size;
                repoChangedFiles += changedFileCount;
                worktrees.push(new WorktreeNode(worktreeKey, w.worktreeName, w.branchName, w.workspaceFolderPath, w.worktreeName === repo.repoName, changedFileCount, children));
            }
            if (!worktrees.length) {
                continue;
            }
            worktrees.sort((a, b) => a.worktreeName.localeCompare(b.worktreeName));
            repo.changedFileCount = repoChangedFiles;
            repos.push(new RepoNode(repo.repoKey, repo.repoName, repo.repoPath, repo.commentCount, repo.changedFileCount, worktrees));
        }
        return repos;
    }
}
exports.PendingTreeProvider = PendingTreeProvider;
PendingTreeProvider.REFRESH_DEBOUNCE_MS = 350;
function buildDirEntryFromFiles(files) {
    const root = { dirs: new Map(), files: new Map() };
    for (const [relKey, info] of files) {
        const segments = relKey.split("/").filter(Boolean);
        if (segments.length === 0) {
            continue;
        }
        const fileName = segments.pop();
        let cursor = root;
        for (const seg of segments) {
            let next = cursor.dirs.get(seg);
            if (!next) {
                next = { dirs: new Map(), files: new Map() };
                cursor.dirs.set(seg, next);
            }
            cursor = next;
        }
        cursor.files.set(fileName, {
            filePath: path.normalize(info.filePath),
            count: info.count,
        });
    }
    return root;
}
function toTreeChildren(entry, parentRelative, worktreeKey, workspaceFolderPath, compact) {
    const out = [];
    const dirNames = Array.from(entry.dirs.keys()).sort((a, b) => a.localeCompare(b));
    for (const name of dirNames) {
        let cursor = entry.dirs.get(name);
        const labelSegments = [name];
        const relSegments = parentRelative ? [parentRelative, name] : [name];
        if (compact) {
            while (cursor.dirs.size === 1 && cursor.files.size === 0) {
                const onlyName = cursor.dirs.keys().next().value;
                labelSegments.push(onlyName);
                relSegments.push(onlyName);
                cursor = cursor.dirs.get(onlyName);
            }
        }
        const label = labelSegments.join("/");
        const relPath = relSegments.join("/");
        const commentCount = countComments(cursor);
        const children = toTreeChildren(cursor, relPath, worktreeKey, workspaceFolderPath, compact);
        out.push(new DirectoryNode(worktreeKey, label, relPath, commentCount, children));
    }
    const fileNames = Array.from(entry.files.keys()).sort((a, b) => a.localeCompare(b));
    for (const name of fileNames) {
        const info = entry.files.get(name);
        const relPath = parentRelative ? `${parentRelative}/${name}` : name;
        out.push(new FileNode(worktreeKey, info.filePath, relPath, info.count, workspaceFolderPath));
    }
    return out;
}
function countComments(entry) {
    let total = 0;
    for (const f of entry.files.values()) {
        total += f.count;
    }
    for (const d of entry.dirs.values()) {
        total += countComments(d);
    }
    return total;
}
// ---------- Git + path helpers ----------
function normRelPath(p) {
    return p.replace(/\\/g, "/").replace(/^\/+/, "");
}
/** `cwd` must be an existing directory (workspace folder, or `path.dirname(filePath)` for a tracked file). */
function tryGetWorktreeRoot(cwd) {
    try {
        const root = (0, node_child_process_1.execFileSync)("git", ["rev-parse", "--show-toplevel"], {
            cwd,
            encoding: "utf8",
            stdio: ["ignore", "pipe", "ignore"],
        }).trim();
        return root ? path.normalize(root) : undefined;
    }
    catch {
        return undefined;
    }
}
function getRepoIdentity(worktreeRoot) {
    try {
        const commonGitDir = (0, node_child_process_1.execFileSync)("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], {
            cwd: worktreeRoot,
            encoding: "utf8",
            stdio: ["ignore", "pipe", "ignore"],
        }).trim();
        const repoRoot = path.normalize(path.dirname(commonGitDir));
        return {
            repoRoot,
            repoName: path.basename(repoRoot),
            worktreeName: path.basename(path.normalize(worktreeRoot)),
        };
    }
    catch {
        const wr = path.normalize(worktreeRoot);
        const base = path.basename(wr);
        return { repoRoot: wr, repoName: base, worktreeName: base };
    }
}
function getRepoIdentityFromFile(filePath) {
    const wt = tryGetWorktreeRoot(path.dirname(filePath));
    if (wt) {
        return getRepoIdentity(wt);
    }
    return getRepoIdentity(path.dirname(filePath));
}
function getBranchName(repoPath) {
    try {
        return ((0, node_child_process_1.execFileSync)("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
            cwd: repoPath,
            encoding: "utf8",
            stdio: ["ignore", "pipe", "ignore"],
        }).trim() || "unknown");
    }
    catch {
        return "unknown";
    }
}
// ---------- Tree item renderers ----------
function repoTreeItem(node) {
    const item = new vscode.TreeItem(node.repoName, vscode.TreeItemCollapsibleState.Expanded);
    item.id = `repo::${node.repoKey}`;
    item.iconPath = new vscode.ThemeIcon("repo");
    const parts = [];
    if (node.changedFileCount > 0) {
        parts.push(`${node.changedFileCount} file${node.changedFileCount === 1 ? "" : "s"}`);
    }
    if (node.commentCount > 0) {
        parts.push(formatCount(node.commentCount));
    }
    item.description = parts.length ? parts.join(" · ") : undefined;
    item.tooltip = node.repoPath || node.repoName;
    item.contextValue = "codeReview.repo";
    return item;
}
function worktreeTreeItem(node) {
    const totalComments = sumChildCommentCounts(node.children);
    const collapsible = node.children.length > 0 ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.None;
    const item = new vscode.TreeItem(node.worktreeName, collapsible);
    item.id = `wt::${node.worktreeKey}`;
    item.iconPath = new vscode.ThemeIcon("git-branch");
    const pieces = [
        node.branchName,
        `${node.changedFileCount} file${node.changedFileCount === 1 ? "" : "s"}`,
    ];
    if (totalComments > 0) {
        pieces.push(formatCount(totalComments));
    }
    item.description = pieces.join(" · ");
    const tooltipLines = [
        `${node.worktreeName} on ${node.branchName}`,
        node.workspaceFolderPath,
    ];
    item.tooltip = tooltipLines.join("\n");
    item.contextValue = node.isRootWorktree ? "codeReview.worktree.root" : "codeReview.worktree";
    return item;
}
function sumChildCommentCounts(children) {
    let total = 0;
    for (const child of children) {
        if (child.kind === "directory") {
            total += sumChildCommentCounts(child.children);
        }
        else {
            total += child.count;
        }
    }
    return total;
}
function directoryTreeItem(node) {
    const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.Expanded);
    item.iconPath = vscode.ThemeIcon.Folder;
    item.description = node.commentCount > 0 ? formatCount(node.commentCount) : undefined;
    item.tooltip = node.relativePath;
    item.contextValue = "codeReview.directory";
    item.id = `dir::${node.worktreeKey}::${normRelPath(node.relativePath)}`;
    return item;
}
function fileTreeItem(node) {
    const fileName = path.basename(node.filePath);
    const item = new vscode.TreeItem(fileName, vscode.TreeItemCollapsibleState.None);
    item.resourceUri = vscode.Uri.file(node.filePath);
    item.iconPath = new vscode.ThemeIcon("comment-discussion", new vscode.ThemeColor("gitDecoration.modifiedResourceForeground"));
    item.description = commentCountBadge(node.count);
    item.tooltip = fileTooltipText(node);
    item.contextValue = "codeReview.file";
    item.id = `file::${node.worktreeKey}::${normRelPath(node.relativePath)}`;
    item.command = {
        command: "codeReview.openFileDiff",
        title: "Open Diff vs Parent Branch",
        arguments: [vscode.Uri.file(node.filePath)],
    };
    return item;
}
function fileTooltipText(node) {
    const lines = ["Pending comments file."];
    lines.push(node.relativePath);
    if (node.count > 0) {
        lines.push(formatCount(node.count));
    }
    return lines.join("\n");
}
function commentCountBadge(n) {
    if (n <= 0) {
        return undefined;
    }
    if (n >= 10) {
        return "10+";
    }
    return String(n);
}
function formatCount(n) {
    return n === 1 ? "1 comment" : `${n} comments`;
}
//# sourceMappingURL=pendingTreeProvider.js.map