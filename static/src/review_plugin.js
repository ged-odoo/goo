// PRs the user commented on in the last 14 days — a single global GitHub search
// (commenter:@me), cached server-side (see GitHubService.reviewed). This plugin
// just requests; the backend returns cached-or-fresh.

const { Plugin, signal } = owl;

export class ReviewPlugin extends Plugin {
  static sequence = 5;

  prs = signal([]); // view state; freshness is the server's job
  at = signal(0);
  loading = signal(false);
  error = signal("");

  // fetch the commented-on PRs (the server caches them). `force` (manual Refresh)
  // adds ?refresh=1 so the backend re-queries instead of serving its cache.
  async load(force = false) {
    this.loading.set(true);
    this.error.set("");
    try {
      const resp = await fetch(force ? "/api/reviews?refresh=1" : "/api/reviews");
      const data = await resp.json();
      if (!data.ok) throw new Error(data.error || "failed");
      this.prs.set(data.prs);
      this.at.set(Date.now());
    } catch (e) {
      this.error.set(e.message);
    } finally {
      this.loading.set(false);
    }
  }
}
