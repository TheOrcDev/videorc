import { defineConfig } from "@neon/config/v1";

// Videorc release storage (Neon project `videorc-releases`, aws-eu-central-1).
// The `releases` bucket on the `production` branch is the single release
// origin: DMGs, updater zips/blockmaps, feeds, manifests, changelog and
// private candidates. Private: every read goes through a presigned URL minted
// by videorc-web or a scoped credential. See docs/releases/release-runbook.md.
export default defineConfig({
  auth: false,
  buckets: {
    releases: { access: "private" },
  },
});
