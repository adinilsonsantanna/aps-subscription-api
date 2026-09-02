type DatabaseDestination = {
  hostname: string;
  port: string;
  database: string;
};

const TEST_DATABASE_NAME = /^[a-z0-9_]+$/;
const TEST_DATABASE_MARKER = /(?:^|_)test(?:_|$)/;
const PRODUCTION_DATABASE_MARKER = /(?:prod(?:uction)?|main)/i;
const PRODUCTION_HOST_MARKER = /(?:^|[.-])(?:prod(?:uction)?|main)(?:[.-]|$)/i;

function invalid(message: string): never {
  throw new Error(`Unsafe PostgreSQL test database: ${message}`);
}

function parseDestination(raw: string, source: "TEST_DATABASE_URL" | "DATABASE_URL"): DatabaseDestination {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return invalid(`${source} is invalid`);
  }

  if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") {
    return invalid(`${source} must use PostgreSQL`);
  }

  const hostname = parsed.hostname.toLowerCase().replace(/\.+$/, "");
  if (!hostname) return invalid(`${source} hostname is empty`);

  const encodedDatabase = parsed.pathname.replace(/^\//, "");
  let database: string;
  try {
    database = decodeURIComponent(encodedDatabase);
  } catch {
    return invalid(`${source} database encoding is invalid`);
  }
  const normalizedDatabase = database.toLowerCase();
  if (!normalizedDatabase) return invalid(`${source} database is empty`);
  if (!TEST_DATABASE_NAME.test(normalizedDatabase)) {
    return invalid(`${source} database contains invalid characters`);
  }

  return {
    hostname,
    port: parsed.port || "5432",
    database: normalizedDatabase,
  };
}

export function assertSafePostgresTestDatabaseUrl(
  testDatabaseUrl: string | undefined,
  productionDatabaseUrl: string | undefined,
): string {
  if (!testDatabaseUrl) invalid("TEST_DATABASE_URL is required");

  const testDestination = parseDestination(testDatabaseUrl, "TEST_DATABASE_URL");
  if (!TEST_DATABASE_MARKER.test(testDestination.database)) {
    invalid("TEST_DATABASE_URL database must contain an isolated test marker");
  }
  if (PRODUCTION_DATABASE_MARKER.test(testDestination.database)) {
    invalid("TEST_DATABASE_URL database resembles production");
  }
  if (PRODUCTION_HOST_MARKER.test(testDestination.hostname)) {
    invalid("TEST_DATABASE_URL hostname resembles production");
  }

  if (productionDatabaseUrl) {
    const productionDestination = parseDestination(productionDatabaseUrl, "DATABASE_URL");
    const sameDestination =
      testDestination.hostname === productionDestination.hostname
      && testDestination.port === productionDestination.port
      && testDestination.database === productionDestination.database;
    if (sameDestination) invalid("TEST_DATABASE_URL must not target DATABASE_URL database");
  }

  return testDatabaseUrl;
}
