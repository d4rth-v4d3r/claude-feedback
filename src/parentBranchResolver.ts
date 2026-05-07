import * as vscode from "vscode";
import { execFileSync } from "node:child_process";
import { getGitApi, type GitRepository } from "./gitTypes";

const PER_BRANCH_KEY = "codeReviewParent";
const GRAPHITE_KEY = "gtParentBranchName";

export type ResolvedParent = {
  /** Repo working-tree path. */
  repoRoot: string;
  /** Current branch name (or "HEAD" if detached). */
  branchName: string;
  /** Reference to diff against. May be a branch (`main`), remote (`origin/main`), or sha. */
  parentRef: string;
  /** SHA at which the parent ref was, used as the left side of the diff. Stable across rebases of the parent. */
  mergeBaseSha: string;
  /** How we resolved this — handy for diagnostics + tree view subtitles. */
  source: "branchConfig" | "graphite" | "workspaceSetting" | "originHead" | "fallback";
};

export class ParentBranchResolver {
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
  async resolve(fileUri: vscode.Uri): Promise<ResolvedParent | undefined> {
    const git = await getGitApi();
    if (!git) {
      return undefined;
    }
    const repo = git.getRepository(fileUri);
    if (!repo) {
      return undefined;
    }
    const branchName = repo.state.HEAD?.name ?? "HEAD";
    const repoRoot = repo.rootUri.fsPath;

    let parentRef: string | undefined;
    let source: ResolvedParent["source"] = "fallback";

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
        .get<string>("parentBranch");
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
  async setParentForCurrentBranch(fileUri: vscode.Uri, parentRef: string): Promise<boolean> {
    const git = await getGitApi();
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
    } catch {
      return false;
    }
  }

  private async computeMergeBase(
    repo: GitRepository,
    repoRoot: string,
    parentRef: string
  ): Promise<string | undefined> {
    try {
      const sha = await repo.getMergeBase("HEAD", parentRef);
      if (sha) {
        return sha;
      }
    } catch {
      // Fall through to CLI.
    }
    try {
      return execFileSync("git", ["merge-base", "HEAD", parentRef], {
        cwd: repoRoot,
        stdio: ["ignore", "pipe", "ignore"],
        encoding: "utf8",
      }).trim();
    } catch {
      return undefined;
    }
  }
}

async function safeGetConfig(repo: GitRepository, key: string): Promise<string | undefined> {
  try {
    const value = await repo.getConfig(key);
    return value && value.trim().length > 0 ? value.trim() : undefined;
  } catch {
    return undefined;
  }
}

function resolveOriginHead(repoRoot: string): string | undefined {
  try {
    const ref = execFileSync(
      "git",
      ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"],
      {
        cwd: repoRoot,
        stdio: ["ignore", "pipe", "ignore"],
        encoding: "utf8",
      }
    ).trim();
    return ref || undefined;
  } catch {
    return undefined;
  }
}
