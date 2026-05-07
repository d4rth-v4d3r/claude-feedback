import * as vscode from "vscode";
import * as path from "node:path";
import type { ReviewComment } from "./types";
import type { ReviewStore } from "./store";

export type PendingTreeItem = RepoNode | WorktreeNode | DirectoryNode | FileNode;

export class RepoNode {
  readonly kind = "repo" as const;
  constructor(
    readonly repoKey: string,
    readonly repoName: string,
    readonly repoPath: string,
    readonly count: number,
    readonly worktrees: WorktreeNode[]
  ) {}
}

export class WorktreeNode {
  readonly kind = "worktree" as const;
  constructor(
    readonly worktreeKey: string,
    readonly worktreeName: string,
    readonly branchName: string,
    readonly workspaceFolderPath: string,
    readonly isRootWorktree: boolean,
    /** Top-level children of the worktree root: directories and any files at the root. */
    readonly children: PendingChildNode[]
  ) {}
}

export class DirectoryNode {
  readonly kind = "directory" as const;
  constructor(
    /** Display label, e.g. "packages/restaurant-ui" when single-child chains are compacted. */
    readonly label: string,
    /** Path relative to the worktree root, used as the stable tree id. */
    readonly relativePath: string,
    readonly count: number,
    readonly children: PendingChildNode[]
  ) {}
}

export class FileNode {
  readonly kind = "file" as const;
  constructor(
    readonly filePath: string,
    /** Path relative to the worktree root. */
    readonly relativePath: string,
    readonly count: number,
    readonly workspaceFolderPath: string
  ) {}
}

export type PendingChildNode = DirectoryNode | FileNode;

export class PendingTreeProvider implements vscode.TreeDataProvider<PendingTreeItem> {
  private readonly emitter = new vscode.EventEmitter<PendingTreeItem | undefined | void>();
  readonly onDidChangeTreeData = this.emitter.event;
  private readonly subscriptions: vscode.Disposable[] = [];

  constructor(private readonly store: ReviewStore) {
    this.subscriptions.push(this.store.onDidChange(() => this.emitter.fire()));
    this.subscriptions.push(
      vscode.workspace.onDidChangeWorkspaceFolders(() => this.emitter.fire())
    );
  }

  dispose(): void {
    vscode.Disposable.from(...this.subscriptions).dispose();
    this.emitter.dispose();
  }

  getTreeItem(element: PendingTreeItem): vscode.TreeItem {
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

  getChildren(element?: PendingTreeItem): PendingTreeItem[] {
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

  private buildRepoNodes(): RepoNode[] {
    const visibleFolders = new Set(
      (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath)
    );
    const pending = this.store
      .getActivePending()
      .filter((c) => visibleFolders.size === 0 || visibleFolders.has(c.workspaceFolderPath));

    const repoMap = new Map<
      string,
      {
        repoKey: string;
        repoName: string;
        repoPath: string;
        count: number;
        worktreeMap: Map<
          string,
          {
            worktreeName: string;
            branchName: string;
            workspaceFolderPath: string;
            isRootWorktree: boolean;
            comments: ReviewComment[];
          }
        >;
      }
    >();

    for (const c of pending) {
      const repoPath = c.repoPath || "";
      const repoKey = repoPath || c.repoName || "Unknown Repo";
      const repoEntry =
        repoMap.get(repoKey) ??
        {
          repoKey,
          repoName: c.repoName || "Unknown Repo",
          repoPath,
          count: 0,
          worktreeMap: new Map(),
        };
      repoEntry.count += 1;

      const worktreeName = c.worktreeName || "Unknown Worktree";
      const worktreeEntry =
        repoEntry.worktreeMap.get(worktreeName) ??
        {
          worktreeName,
          branchName: c.branchName || "unknown",
          workspaceFolderPath: c.workspaceFolderPath,
          isRootWorktree: worktreeName === repoEntry.repoName,
          comments: [],
        };
      worktreeEntry.comments.push(c);

      repoEntry.worktreeMap.set(worktreeName, worktreeEntry);
      repoMap.set(repoKey, repoEntry);
    }

    const compactFolders = vscode.workspace
      .getConfiguration("codeReview")
      .get<boolean>("compactFolders", true);

    return Array.from(repoMap.values()).map((repo) => {
      const worktrees = Array.from(repo.worktreeMap.values()).map((w) => {
        const dirEntry = buildDirEntry(w.comments);
        const children = toTreeChildren(
          dirEntry,
          "",
          w.workspaceFolderPath,
          compactFolders
        );
        return new WorktreeNode(
          `${repo.repoKey}::${w.worktreeName}`,
          w.worktreeName,
          w.branchName,
          w.workspaceFolderPath,
          w.isRootWorktree,
          children
        );
      });
      worktrees.sort((a, b) => a.worktreeName.localeCompare(b.worktreeName));
      return new RepoNode(repo.repoKey, repo.repoName, repo.repoPath, repo.count, worktrees);
    });
  }
}

// ---------- Directory tree construction ----------

type DirEntry = {
  /** Subdirectories keyed by their single segment name. */
  readonly dirs: Map<string, DirEntry>;
  /** Files at this directory level, keyed by basename. */
  readonly files: Map<string, { filePath: string; count: number }>;
};

function buildDirEntry(comments: ReviewComment[]): DirEntry {
  const root: DirEntry = { dirs: new Map(), files: new Map() };
  for (const c of comments) {
    const segments = (c.relativePath || "").split(/[\\/]+/).filter(Boolean);
    if (segments.length === 0) {
      continue;
    }
    const fileName = segments.pop() as string;
    let cursor = root;
    for (const seg of segments) {
      let next = cursor.dirs.get(seg);
      if (!next) {
        next = { dirs: new Map(), files: new Map() };
        cursor.dirs.set(seg, next);
      }
      cursor = next;
    }
    const existing = cursor.files.get(fileName);
    if (existing) {
      existing.count += 1;
    } else {
      cursor.files.set(fileName, { filePath: c.filePath, count: 1 });
    }
  }
  return root;
}

function toTreeChildren(
  entry: DirEntry,
  parentRelative: string,
  workspaceFolderPath: string,
  compact: boolean
): PendingChildNode[] {
  const out: PendingChildNode[] = [];

  const dirNames = Array.from(entry.dirs.keys()).sort((a, b) => a.localeCompare(b));
  for (const name of dirNames) {
    let cursor = entry.dirs.get(name) as DirEntry;
    const labelSegments = [name];
    const relSegments = parentRelative ? [parentRelative, name] : [name];
    if (compact) {
      while (cursor.dirs.size === 1 && cursor.files.size === 0) {
        const onlyName = cursor.dirs.keys().next().value as string;
        labelSegments.push(onlyName);
        relSegments.push(onlyName);
        cursor = cursor.dirs.get(onlyName) as DirEntry;
      }
    }
    const label = labelSegments.join("/");
    const relPath = relSegments.join("/");
    const childCount = countComments(cursor);
    const children = toTreeChildren(cursor, relPath, workspaceFolderPath, compact);
    out.push(new DirectoryNode(label, relPath, childCount, children));
  }

  const fileNames = Array.from(entry.files.keys()).sort((a, b) => a.localeCompare(b));
  for (const name of fileNames) {
    const info = entry.files.get(name) as { filePath: string; count: number };
    const relPath = parentRelative ? `${parentRelative}/${name}` : name;
    out.push(new FileNode(info.filePath, relPath, info.count, workspaceFolderPath));
  }

  return out;
}

function countComments(entry: DirEntry): number {
  let total = 0;
  for (const f of entry.files.values()) {
    total += f.count;
  }
  for (const d of entry.dirs.values()) {
    total += countComments(d);
  }
  return total;
}

// ---------- Tree item renderers ----------

function repoTreeItem(node: RepoNode): vscode.TreeItem {
  const item = new vscode.TreeItem(node.repoName, vscode.TreeItemCollapsibleState.Expanded);
  item.iconPath = new vscode.ThemeIcon("repo");
  item.description = formatCount(node.count);
  item.tooltip = node.repoPath || node.repoName;
  item.contextValue = "codeReview.repo";
  return item;
}

function worktreeTreeItem(node: WorktreeNode): vscode.TreeItem {
  const total = sumChildCounts(node.children);
  const item = new vscode.TreeItem(node.worktreeName, vscode.TreeItemCollapsibleState.Expanded);
  item.iconPath = new vscode.ThemeIcon("git-branch");
  item.description = `${node.branchName} · ${formatCount(total)}`;
  item.tooltip = `${node.worktreeName} on ${node.branchName}\n${node.workspaceFolderPath}`;
  item.contextValue = node.isRootWorktree ? "codeReview.worktree.root" : "codeReview.worktree";
  return item;
}

function sumChildCounts(children: PendingChildNode[]): number {
  let total = 0;
  for (const child of children) {
    total += child.count;
  }
  return total;
}

function directoryTreeItem(node: DirectoryNode): vscode.TreeItem {
  const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.Expanded);
  item.iconPath = vscode.ThemeIcon.Folder;
  item.description = formatCount(node.count);
  item.tooltip = node.relativePath;
  item.contextValue = "codeReview.directory";
  item.id = `dir::${node.relativePath}`;
  return item;
}

function fileTreeItem(node: FileNode): vscode.TreeItem {
  const fileName = path.basename(node.filePath);
  const item = new vscode.TreeItem(fileName, vscode.TreeItemCollapsibleState.None);
  item.resourceUri = vscode.Uri.file(node.filePath);
  item.tooltip = `${node.relativePath} · ${formatCount(node.count)}`;
  item.contextValue = "codeReview.file";
  item.command = {
    command: "codeReview.openFileDiff",
    title: "Open Diff vs Parent Branch",
    arguments: [vscode.Uri.file(node.filePath)],
  };
  return item;
}

function formatCount(n: number): string {
  return n === 1 ? "1 comment" : `${n} comments`;
}
