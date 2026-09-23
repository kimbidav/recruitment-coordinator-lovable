# Welcome to your Lovable project

## Project info

**URL**: https://lovable.dev/projects/REPLACE_WITH_PROJECT_ID

## Documentation

- [CLAUDE.md](CLAUDE.md) — business context and the rules that encode it; read this before changing pipeline logic.
- [docs/v2-rollout.md](docs/v2-rollout.md) — the v2 release runbook: migration order, Railway/Supabase secrets, Slack app changes, per-recruiter onboarding, pilot.
- [docs/ashby-architecture.md](docs/ashby-architecture.md) — how the Ashby pipeline integration works end-to-end (browser → Supabase edge function → Railway extractor → Ashby): the shared-session auth model, the async sweep, accumulate-and-merge, and storage. Read this first for the Ashby feature.
- [docs/ashby-data-schemas.md](docs/ashby-data-schemas.md) — record shapes at each hop, the Supabase table DDL, and the Ashby REST/GraphQL API inventory.
- [docs/shared-ashby-session-setup.md](docs/shared-ashby-session-setup.md) — one-time infra checklist (Railway volume + secrets + migrations) to activate the shared team session.
- [docs/slack-integration.md](docs/slack-integration.md) — the Slack side: per-user OAuth and scopes, submission ingestion (sync + events), the slack-thread actions (reply/post/close/find), follow-up bar, and scope-rollout troubleshooting.

## How can I edit this code?

There are several ways of editing your application.

**Use Lovable**

Simply visit the [Lovable Project](https://lovable.dev/projects/REPLACE_WITH_PROJECT_ID) and start prompting.

Changes made via Lovable will be committed automatically to this repo.

**Use your preferred IDE**

If you want to work locally using your own IDE, you can clone this repo and push changes. Pushed changes will also be reflected in Lovable.

The only requirement is having Node.js & npm installed - [install with nvm](https://github.com/nvm-sh/nvm#installing-and-updating)

Follow these steps:

```sh
# Step 1: Clone the repository using the project's Git URL.
git clone <YOUR_GIT_URL>

# Step 2: Navigate to the project directory.
cd <YOUR_PROJECT_NAME>

# Step 3: Install the necessary dependencies.
npm i

# Step 4: Start the development server with auto-reloading and an instant preview.
npm run dev
```

**Edit a file directly in GitHub**

- Navigate to the desired file(s).
- Click the "Edit" button (pencil icon) at the top right of the file view.
- Make your changes and commit the changes.

**Use GitHub Codespaces**

- Navigate to the main page of your repository.
- Click on the "Code" button (green button) near the top right.
- Select the "Codespaces" tab.
- Click on "New codespace" to launch a new Codespace environment.
- Edit files directly within the Codespace and commit and push your changes once you're done.

## What technologies are used for this project?

This project is built with:

- Vite
- TypeScript
- React
- shadcn-ui
- Tailwind CSS

## How can I deploy this project?

Simply open [Lovable](https://lovable.dev/projects/REPLACE_WITH_PROJECT_ID) and click on Share -> Publish.

## Can I connect a custom domain to my Lovable project?

Yes, you can!

To connect a domain, navigate to Project > Settings > Domains and click Connect Domain.

Read more here: [Setting up a custom domain](https://docs.lovable.dev/features/custom-domain#custom-domain)
