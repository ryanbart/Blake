// Tests hit the local Postgres from scripts/dev-db.sh; load .env the same way
// the app does so DATABASE_URL and the kill-switch default are present.
import "dotenv/config";
