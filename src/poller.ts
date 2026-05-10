import type { DB } from "./db.js";
import type { GitHub } from "./github.js";
import type { ProjectConfig } from "./project_config.js";

/**
 * Periodically polls GitHub for the release that the project's CI publishes
 * for each open PR, and updates `pr_links.artifact_url` / `qr_url` accordingly.
 */
export class ArtifactPoller {
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private db: DB,
    private github: GitHub,
    private cfg: ProjectConfig,
    private intervalMs: number = 30_000,
  ) {}

  start(): void {
    if (!this.cfg.ship) return;
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.tickSafe();
    }, this.intervalMs);
    // Don't keep the event loop alive for this.
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private tickSafe(): void {
    try {
      this.tick();
    } catch (e) {
      console.error("[poller] tick failed:", (e as Error).message);
    }
  }

  private tick(): void {
    const ship = this.cfg.ship;
    if (!ship) return;
    const links = this.db.listOpenPrLinks();
    for (const link of links) {
      if (link.artifact_url) continue; // already resolved
      if (link.pr_number == null) continue;
      const sha = this.github.prHeadSha(link.pr_number);
      if (!sha) continue;
      const found = this.github.findReleaseAsset({
        prNumber: link.pr_number,
        headSha: sha,
        releaseTagPattern: ship.releaseTagPattern,
        assetPattern: ship.artifactAssetPattern,
      });
      if (found.assetUrl) {
        this.db.upsertPrLink({
          session_id: link.session_id,
          artifact_url: found.assetUrl,
          qr_url: found.qrUrl ?? null,
        });
        console.log(
          `[poller] resolved artifact for session ${link.session_id} → ${found.assetUrl}`,
        );
      }
    }
  }
}
