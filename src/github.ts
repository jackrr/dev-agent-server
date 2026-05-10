import { spawnSync } from "node:child_process";

/**
 * Thin wrappers around the `gh` CLI, executed on the host (not in the sandbox).
 * The host is expected to have `gh` installed and authenticated via GITHUB_TOKEN.
 */
export class GitHub {
  constructor(
    private targetRepo: string, // owner/repo
    private token: string | undefined,
  ) {}

  /** Pushes the worktree's current branch and opens a PR. */
  openPr(args: {
    worktreePath: string;
    branch: string;
    baseBranch: string;
    title: string;
    body: string;
  }): { prNumber: number; prUrl: string } {
    // Push the branch first.
    const push = spawnSync("git", ["push", "-u", "origin", args.branch], {
      cwd: args.worktreePath,
      encoding: "utf8",
      env: { ...process.env, GH_TOKEN: this.token, GITHUB_TOKEN: this.token },
    });
    if (push.status !== 0) {
      throw new Error(`git push failed: ${push.stderr}`);
    }
    const create = this.gh([
      "pr",
      "create",
      "--repo",
      this.targetRepo,
      "--base",
      args.baseBranch,
      "--head",
      args.branch,
      "--title",
      args.title,
      "--body",
      args.body,
    ]);
    const url = create.stdout.trim().split(/\s+/).pop() ?? "";
    const m = url.match(/\/pull\/(\d+)/);
    if (!m) throw new Error(`could not parse PR url from gh output: ${create.stdout}`);
    return { prNumber: Number(m[1]!), prUrl: url };
  }

  /**
   * Resolves an artifact URL for a PR by:
   *  1. Computing the release tag from `releaseTagPattern` (placeholders: {pr_number}, {short_sha}).
   *  2. Looking up the release via `gh release view`.
   *  3. Picking the first asset whose name matches `assetPattern` (glob).
   */
  findReleaseAsset(args: {
    prNumber: number;
    headSha: string;
    releaseTagPattern: string;
    assetPattern: string;
  }): { tag: string; assetUrl?: string; qrUrl?: string } {
    const shortSha = args.headSha.slice(0, 7);
    const tag = args.releaseTagPattern
      .replace("{pr_number}", String(args.prNumber))
      .replace("{short_sha}", shortSha);
    const r = spawnSync(
      "gh",
      ["release", "view", tag, "--repo", this.targetRepo, "--json", "assets"],
      {
        encoding: "utf8",
        env: { ...process.env, GH_TOKEN: this.token, GITHUB_TOKEN: this.token },
      },
    );
    if (r.status !== 0) {
      // Release not yet published.
      return { tag };
    }
    let assets: { name: string; url: string }[] = [];
    try {
      const parsed = JSON.parse(r.stdout) as { assets: { name: string; url: string }[] };
      assets = parsed.assets;
    } catch {
      return { tag };
    }
    const re = globToRegex(args.assetPattern);
    const main = assets.find((a) => re.test(a.name));
    const qr = assets.find((a) => /\.png$/i.test(a.name) && /qr/i.test(a.name));
    return { tag, assetUrl: main?.url, qrUrl: qr?.url };
  }

  /** Fetches the head SHA of a PR. */
  prHeadSha(prNumber: number): string | null {
    const r = this.ghOptional([
      "pr",
      "view",
      String(prNumber),
      "--repo",
      this.targetRepo,
      "--json",
      "headRefOid",
    ]);
    if (!r) return null;
    try {
      return (JSON.parse(r) as { headRefOid: string }).headRefOid;
    } catch {
      return null;
    }
  }

  private gh(args: string[]): { stdout: string; stderr: string } {
    const r = spawnSync("gh", args, {
      encoding: "utf8",
      env: { ...process.env, GH_TOKEN: this.token, GITHUB_TOKEN: this.token },
    });
    if (r.status !== 0) {
      throw new Error(`gh ${args.join(" ")} failed: ${r.stderr}`);
    }
    return { stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
  }

  private ghOptional(args: string[]): string | null {
    const r = spawnSync("gh", args, {
      encoding: "utf8",
      env: { ...process.env, GH_TOKEN: this.token, GITHUB_TOKEN: this.token },
    });
    if (r.status !== 0) return null;
    return r.stdout ?? "";
  }
}

function globToRegex(glob: string): RegExp {
  const esc = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${esc}$`);
}
