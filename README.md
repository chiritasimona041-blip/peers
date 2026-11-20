# The Peers Certification backend

Cloudflare Worker (Hono) + D1 (SQLite). Started as a clone of the Cyberally engine (17 Nov 2026) and adapted for thepeerscertification.com. Fully separate: own Worker, own empty database, no link to Cyberally.

## What it does
- Sign in, forgot and reset password, learner account (name, email, password)
- Admin: learners, courses and lessons, exam questions, orders, certificates (revoke only), enquiries, email log
- `GET /api/catalogue` public list of certifications on sale (no lessons, no answers)
- `POST /api/enrol` name + email, then straight to Stripe Checkout (no basket)
- `POST /api/stripe/webhook` signed payment confirmation: creates the learner, adds the course, emails a set-password link
- `GET /api/exam`, `POST /api/exam/submit` multiple choice, pass mark 80% (`PASS_MARK`), retakes allowed
- `GET /api/certificates` the learner's certificates; `GET /api/verify?no=` public check
- A learner can only read the courses they are enrolled on

Everything specific to Cyberally has been deleted (expert accounts and profiles, visitor chat, sponsored learners and unlock reviews, testimonial submissions). What is left is a backend for buying, studying and certifying.

## Data shapes (document store)
- `courses/<id>`: `{ title, tag, blurb, price (pence), cur?, live?, modules: [{ title, lessons: [...] }] }` (id: letters, digits, hyphens, max 24)
- `exams/<courseId>`: `{ pass?, q: [{ q, o: [..], a: index }] }`
- `orders/<uuid>`, `certs/<number>`, `lexam/<learner>--<course>` are written by the server only

## Before go-live
Secrets: `SETUP_TOKEN`, `SMTP_PASS` (the info@ mailbox password), `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`; optional `SITE_ORIGIN`. `NOTIFY_TO`, `SMTP_USER`, `SMTP_HOST` and `SMTP_PORT` are set in `wrangler.toml` (info@thepeerscertification.com on mail.privateemail.com, port 465); do not also set them as secrets, or deploy will refuse the duplicate names.
Until the Stripe keys are set, enrol answers "Online payment is not switched on yet" and gives nothing away.
The Stripe calls have only been tested against signed test payloads, not against Stripe itself: run one real test-mode payment before launch.
`public/` holds the site: homepage, certifications, certification page, welcome, sign in, forgot and set password, verify, contact, learner dashboard, course player, exam, certificate and account. Shared look in `public/assets/site.css`, shared behaviour in `public/assets/app.js`. Still to build: admin screens and the legal pages.
`tools/seed-sample.mjs` loads SAMPLE certifications, lessons and exam questions for local preview only.

## Deploy from GitHub (Cloudflare Workers Builds)
Every push to `main` builds and deploys the site. No commands needed: the Worker creates its own database tables on first use.
1. Cloudflare dashboard > Storage & databases > D1 SQL database > Create: name it `thepeerscertification`. Copy its Database ID into `database_id` in `wrangler.toml` and push.
2. Workers & Pages > Create > Import a repository: pick this repository. Project name `peers` (must match `name` in `wrangler.toml`). Deploy command: `npx wrangler deploy`.
3. The Worker > Settings > Variables and Secrets > Add: type Secret, name `SETUP_TOKEN`, a long random value. Add the other secrets the same way when ready.
4. Open `/setup` on the site once: it creates the admin and loads the 20 certifications.

## Commands
- `npm test` end-to-end suite against a local D1 database
- `npm run dev` run locally; `npm run migrate:local` apply migrations locally
- `npm run deploy` apply migrations to the live database, then deploy
- `node tools/go-live.mjs <site address>` first run on the live site: creates the first admin and loads the 20 certifications (needs SETUP_TOKEN, ADMIN_EMAIL, ADMIN_PASSWORD)
