import "dotenv/config";

/**
 * Point tests at a separate database.
 *
 * The provenance suite TRUNCATEs every table between tests. Pointed at the dev
 * database that silently destroys the seeded dataset, so `npm test` and
 * `npm run seed` would fight each other and a contributor would lose their
 * working data by running the tests.
 *
 * Set TEST_DATABASE_URL to override. The default appends `_test` to the dev
 * database name, so `npm run db:up` plus `npx prisma migrate deploy` against
 * that URL is all the setup required.
 */
const devUrl = process.env.DATABASE_URL ?? "";
const testUrl =
  process.env.TEST_DATABASE_URL ??
  devUrl.replace(/\/([^/?]+)(\?|$)/, (_match, name: string, tail: string) =>
    name.endsWith("_test") ? `/${name}${tail}` : `/${name}_test${tail}`,
  );

if (!testUrl) {
  throw new Error(
    "No DATABASE_URL. Run `npm run db:up` and copy the printed URL into .env.",
  );
}
if (testUrl === devUrl) {
  throw new Error(
    `Refusing to run tests against the development database (${devUrl}). ` +
      "Set TEST_DATABASE_URL to a separate database.",
  );
}

process.env.DATABASE_URL = testUrl;

// Tests assert the shipped-safe default; an .env with the switch off must not
// silently change what the provenance suite is verifying.
process.env.AUTOMATION_KILL_SWITCH = "true";
