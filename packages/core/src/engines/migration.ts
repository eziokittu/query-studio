// Pair-specific migration content for the "X to Y" conversion landing pages.
//
// ── why this file exists ────────────────────────────────────────────────────
//
// The conversion pages were generated entirely from two dialect names. Every
// sentence on them was a template with the names substituted in, which meant
// that measured against each other, /mysql-to-postgresql and
// /postgresql-to-mysql shared 98.9% of their vocabulary and 58.5% of their
// five-word phrases, at about 420 words each. Fifteen pages of that is the
// exact shape of a doorway-page cluster: the right URLs, the right titles, and
// nothing on them that a search engine could prefer over the other fourteen.
//
// The strategy was never wrong — "mysql to postgresql" is a real, high-volume,
// persistent query and a dedicated page is how you answer it. What was missing
// was anything true about *that specific pair* that isn't true about the other
// fourteen.
//
// So this file holds the part that cannot be generated from a name: the type
// mappings that actually differ, the migration gotchas that actually bite, and
// an honest account of what a syntax translator does not do. It is knowledge,
// not scaffolding, and it is why these pages are now worth ranking.
//
// ── the honesty section is load-bearing ─────────────────────────────────────
//
// `LIMITS` tells the reader what the tool will not convert — stored procedures,
// triggers, vendor extensions, anything semantic rather than syntactic. That is
// there because it is true and because a page that only lists strengths reads
// like a landing page and gets treated like one. It is also the single most
// useful paragraph on the page for somebody midway through a real migration.

export interface TypeMapping {
  from: string;
  to: string;
  /** Why it is not a straight swap, when it isn't. Omit when it genuinely is. */
  note?: string;
}

export interface Gotcha {
  title: string;
  body: string;
  /** Optional before/after, where seeing it is faster than reading about it. */
  before?: string;
  after?: string;
}

export interface PairContent {
  /** One paragraph on how close these two dialects actually are. */
  intro: string;
  types: TypeMapping[];
  gotchas: Gotcha[];
  faq: { q: string; a: string }[];
}

// ── Data type mappings ─────────────────────────────────────────────────────
//
// Keyed "from>to". Only pairs with a published landing page need an entry;
// `typeMappingsFor` composes a sensible fallback from the two dialects'
// families for anything not listed.

const TYPES: Record<string, TypeMapping[]> = {
  "mysql>postgresql": [
    { from: "INT AUTO_INCREMENT", to: "INTEGER GENERATED ALWAYS AS IDENTITY", note: "SERIAL still works and is shorter, but IDENTITY is the SQL-standard form and does not leave an ownerless sequence behind if the column is dropped." },
    { from: "TINYINT(1)", to: "BOOLEAN", note: "MySQL has no real boolean — TINYINT(1) is the convention. Any code comparing the column to 0 or 1 has to change to FALSE/TRUE." },
    { from: "DATETIME", to: "TIMESTAMP", note: "Neither carries a time zone. Consider TIMESTAMPTZ instead; it is almost always what was meant." },
    { from: "TIMESTAMP", to: "TIMESTAMPTZ", note: "MySQL's TIMESTAMP converts to UTC on write and back on read. TIMESTAMPTZ is the closest equivalent; plain TIMESTAMP is not." },
    { from: "ENUM('a','b')", to: "CREATE TYPE … AS ENUM / CHECK constraint", note: "Postgres enums are standalone types created before the table. A CHECK constraint on TEXT is easier to alter later." },
    { from: "DOUBLE", to: "DOUBLE PRECISION" },
    { from: "LONGTEXT / MEDIUMTEXT / TEXT", to: "TEXT", note: "Postgres has one unbounded text type and no length tiers." },
    { from: "BLOB / LONGBLOB", to: "BYTEA" },
    { from: "UNSIGNED INT", to: "BIGINT + CHECK (col >= 0)", note: "Postgres has no unsigned types. Widening to BIGINT preserves the range; the CHECK preserves the intent." },
    { from: "JSON", to: "JSONB", note: "JSONB is binary, indexable and reorders keys. Use JSON only if byte-for-byte round-tripping matters." },
    { from: "DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP", to: "A BEFORE UPDATE trigger", note: "Postgres has no ON UPDATE clause; the auto-updating timestamp needs a trigger function." },
  ],
  "postgresql>mysql": [
    { from: "SERIAL / GENERATED AS IDENTITY", to: "INT AUTO_INCREMENT", note: "MySQL allows one auto-increment column per table and it must be indexed." },
    { from: "BOOLEAN", to: "TINYINT(1)", note: "MySQL accepts the BOOLEAN keyword but stores TINYINT(1). TRUE and FALSE become 1 and 0." },
    { from: "TEXT", to: "TEXT / LONGTEXT", note: "MySQL's TEXT caps at 64 KB. Anything that might exceed that needs MEDIUMTEXT or LONGTEXT." },
    { from: "TIMESTAMPTZ", to: "DATETIME (store UTC)", note: "MySQL's TIMESTAMP has a range ending in 2038 and does time-zone conversion on read. Storing UTC in a DATETIME is the usual answer." },
    { from: "UUID", to: "CHAR(36) or BINARY(16)", note: "MySQL has no UUID type. BINARY(16) with UUID_TO_BIN() is a quarter of the size and indexes far better." },
    { from: "JSONB", to: "JSON", note: "MySQL's JSON is already binary. Postgres's JSONB operators (@>, ?, #>) have no direct equivalent — they become JSON_CONTAINS and JSON_EXTRACT." },
    { from: "TEXT[] / any array type", to: "JSON, or a join table", note: "MySQL has no array types at all. This is a schema change, not a type change." },
    { from: "BYTEA", to: "BLOB / LONGBLOB" },
    { from: "NUMERIC without precision", to: "DECIMAL(65,30)", note: "MySQL requires explicit precision; unconstrained NUMERIC has no equivalent." },
    { from: "INTERVAL", to: "No equivalent type", note: "Store as seconds in an integer, or use MySQL's INTERVAL expression syntax inline." },
    { from: "CREATE TYPE … AS ENUM", to: "ENUM('a','b') inline on the column", note: "MySQL enums are per-column, not shared types." },
  ],
  "sqlserver>postgresql": [
    { from: "INT IDENTITY(1,1)", to: "INTEGER GENERATED ALWAYS AS IDENTITY" },
    { from: "NVARCHAR(n) / NVARCHAR(MAX)", to: "VARCHAR(n) / TEXT", note: "Postgres text is UTF-8 throughout, so the N prefix has no meaning and no cost." },
    { from: "DATETIME2", to: "TIMESTAMP" },
    { from: "DATETIMEOFFSET", to: "TIMESTAMPTZ" },
    { from: "BIT", to: "BOOLEAN", note: "1/0 becomes TRUE/FALSE — check anything comparing the column to a number." },
    { from: "UNIQUEIDENTIFIER", to: "UUID" },
    { from: "VARBINARY(MAX)", to: "BYTEA" },
    { from: "MONEY", to: "NUMERIC(19,4)", note: "Postgres has a MONEY type but it is locale-dependent and generally avoided." },
    { from: "[bracketed identifiers]", to: '"double-quoted identifiers"', note: "Postgres folds unquoted identifiers to lowercase; SQL Server preserves case. A quoted \"MyTable\" is not the same object as MyTable." },
  ],
  "postgresql>sqlserver": [
    { from: "SERIAL", to: "INT IDENTITY(1,1)" },
    { from: "TEXT", to: "NVARCHAR(MAX)" },
    { from: "BOOLEAN", to: "BIT" },
    { from: "TIMESTAMPTZ", to: "DATETIMEOFFSET" },
    { from: "UUID", to: "UNIQUEIDENTIFIER" },
    { from: "BYTEA", to: "VARBINARY(MAX)" },
    { from: "JSONB", to: "NVARCHAR(MAX) + JSON_VALUE/OPENJSON", note: "SQL Server has JSON functions but no JSON storage type." },
    { from: "TEXT[]", to: "No equivalent", note: "Arrays need a join table or a JSON column." },
    { from: "LIMIT n", to: "TOP n or OFFSET … FETCH", note: "TOP cannot be combined with OFFSET; paginated queries need the OFFSET/FETCH form, which requires an ORDER BY." },
  ],
  "mysql>sqlserver": [
    { from: "INT AUTO_INCREMENT", to: "INT IDENTITY(1,1)" },
    { from: "TINYINT(1)", to: "BIT" },
    { from: "DATETIME", to: "DATETIME2", note: "DATETIME2 has better precision and range; plain DATETIME exists in both and means different things." },
    { from: "TEXT / LONGTEXT", to: "NVARCHAR(MAX)" },
    { from: "BLOB", to: "VARBINARY(MAX)" },
    { from: "ENUM('a','b')", to: "VARCHAR(n) + CHECK constraint", note: "SQL Server has no ENUM type." },
    { from: "`backtick identifiers`", to: "[bracketed identifiers]" },
    { from: "LIMIT n", to: "TOP n" },
    { from: "IFNULL()", to: "ISNULL()", note: "COALESCE works in both and is the portable choice." },
  ],
  "sqlserver>mysql": [
    { from: "INT IDENTITY(1,1)", to: "INT AUTO_INCREMENT" },
    { from: "NVARCHAR(MAX)", to: "LONGTEXT" },
    { from: "BIT", to: "TINYINT(1)" },
    { from: "DATETIME2", to: "DATETIME(6)" },
    { from: "UNIQUEIDENTIFIER", to: "CHAR(36) or BINARY(16)" },
    { from: "VARBINARY(MAX)", to: "LONGBLOB" },
    { from: "TOP n", to: "LIMIT n" },
    { from: "[bracketed identifiers]", to: "`backtick identifiers`" },
  ],
  "sqlite>postgresql": [
    { from: "INTEGER PRIMARY KEY AUTOINCREMENT", to: "INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY" },
    { from: "TEXT (any declared type)", to: "A real type", note: "SQLite has dynamic typing — a column declared INTEGER will happily store 'banana'. Postgres will not. Expect to clean data, not just schema." },
    { from: "REAL", to: "DOUBLE PRECISION" },
    { from: "BLOB", to: "BYTEA" },
    { from: "NUMERIC", to: "NUMERIC(p,s)", note: "Give it explicit precision; SQLite's is advisory." },
    { from: "No boolean type (0/1)", to: "BOOLEAN" },
    { from: "Dates stored as TEXT/INTEGER", to: "DATE / TIMESTAMPTZ", note: "SQLite has no date type. Whatever convention the app used (ISO strings, Unix epochs, Julian days) has to be converted explicitly." },
  ],
  "mysql>mariadb": [
    { from: "Everything", to: "Everything", note: "MariaDB is a fork of MySQL and the types are the same. This pair is about the small number of places they have diverged since 2009, not about type conversion." },
  ],
  "db2>postgresql": [
    { from: "GENERATED ALWAYS AS IDENTITY", to: "GENERATED ALWAYS AS IDENTITY", note: "Same standard syntax — one of the few things that carries over unchanged." },
    { from: "VARCHAR(n) FOR BIT DATA", to: "BYTEA" },
    { from: "TIMESTAMP", to: "TIMESTAMP / TIMESTAMPTZ" },
    { from: "DECFLOAT", to: "NUMERIC", note: "Postgres has no decimal-floating-point type; NUMERIC is arbitrary-precision and the closest match." },
    { from: "GRAPHIC / VARGRAPHIC", to: "TEXT" },
    { from: "FETCH FIRST n ROWS ONLY", to: "LIMIT n", note: "Postgres also accepts FETCH FIRST, so this one can be left alone if you prefer the standard form." },
  ],
  "mysql>bigquery": [
    { from: "INT / BIGINT", to: "INT64", note: "BigQuery has one integer type." },
    { from: "DOUBLE / FLOAT", to: "FLOAT64" },
    { from: "DECIMAL(p,s)", to: "NUMERIC / BIGNUMERIC" },
    { from: "VARCHAR(n) / TEXT", to: "STRING", note: "No length limits, and no length enforcement." },
    { from: "TINYINT(1)", to: "BOOL" },
    { from: "DATETIME", to: "DATETIME or TIMESTAMP", note: "BigQuery distinguishes them strictly: TIMESTAMP is an absolute instant, DATETIME is a wall-clock reading with no zone." },
    { from: "BLOB", to: "BYTES" },
    { from: "JSON", to: "JSON" },
    { from: "AUTO_INCREMENT", to: "No equivalent", note: "BigQuery is analytical and has no sequences. Generate keys upstream, or use GENERATE_UUID()." },
  ],
  "postgresql>snowflake": [
    { from: "TEXT / VARCHAR(n)", to: "VARCHAR", note: "Snowflake stores all strings the same way; a length is a constraint, not an optimisation." },
    { from: "SERIAL", to: "NUMBER AUTOINCREMENT" },
    { from: "TIMESTAMPTZ", to: "TIMESTAMP_TZ" },
    { from: "TIMESTAMP", to: "TIMESTAMP_NTZ" },
    { from: "JSONB", to: "VARIANT", note: "VARIANT is Snowflake's semi-structured type; access is via colon notation (col:field) rather than -> and ->>." },
    { from: "TEXT[]", to: "ARRAY" },
    { from: "INTEGER / BIGINT / NUMERIC", to: "NUMBER(38,0)", note: "Snowflake has one numeric type under several aliases." },
    { from: "BYTEA", to: "BINARY" },
  ],
  "bigquery>snowflake": [
    { from: "INT64", to: "NUMBER(38,0)" },
    { from: "FLOAT64", to: "FLOAT" },
    { from: "STRING", to: "VARCHAR" },
    { from: "BYTES", to: "BINARY" },
    { from: "STRUCT<…>", to: "OBJECT / VARIANT", note: "BigQuery structs are strongly typed; Snowflake's OBJECT is not, so field types are checked at read time rather than write time." },
    { from: "ARRAY<T>", to: "ARRAY", note: "Snowflake arrays are untyped and can hold mixed values." },
    { from: "TIMESTAMP", to: "TIMESTAMP_TZ" },
    { from: "DATETIME", to: "TIMESTAMP_NTZ" },
  ],
  "postgresql>redshift": [
    { from: "TEXT", to: "VARCHAR(65535)", note: "Redshift has no unbounded text type and a hard 65,535-byte row limit for VARCHAR." },
    { from: "JSONB", to: "SUPER, or VARCHAR", note: "SUPER is the semi-structured type. Most Postgres JSONB operators do not carry over." },
    { from: "UUID", to: "CHAR(36)", note: "Redshift has no UUID type." },
    { from: "SERIAL", to: "INTEGER IDENTITY(1,1)", note: "Redshift identity values are not guaranteed gap-free or monotonic across slices." },
    { from: "TEXT[]", to: "SUPER, or a join table" },
    { from: "TIMESTAMPTZ", to: "TIMESTAMPTZ" },
    { from: "Foreign keys / UNIQUE", to: "Declared but not enforced", note: "Redshift accepts constraint syntax and does not enforce it — the planner uses it as a hint. This surprises people badly." },
  ],
};

// ── Migration gotchas ──────────────────────────────────────────────────────

const GOTCHAS: Record<string, Gotcha[]> = {
  "mysql>postgresql": [
    {
      title: "Identifier case folding will break queries that looked fine",
      body: "MySQL on Linux is case-sensitive for table names and case-insensitive for column names. PostgreSQL folds every unquoted identifier to lowercase, and treats a double-quoted identifier as case-sensitive and literal. So a table created as \"UserAccounts\" can only ever be referenced as \"UserAccounts\"; writing UserAccounts unquoted looks for useraccounts and fails. The safest migration is to lowercase every identifier and never quote them again.",
      before: "SELECT `userId` FROM `UserAccounts`;",
      after: "SELECT user_id FROM user_accounts;",
    },
    {
      title: "GROUP BY is strict, and your queries probably are not",
      body: "MySQL historically let you SELECT columns that were neither aggregated nor grouped, returning an arbitrary row's value. PostgreSQL rejects that outright with \"column must appear in the GROUP BY clause or be used in an aggregate function\". This is the single most common source of queries that break after a migration, and it is usually a latent bug rather than a syntax problem — the query was returning arbitrary data all along.",
      before: "SELECT user_id, name, COUNT(*) FROM orders GROUP BY user_id;",
      after: "SELECT user_id, MIN(name) AS name, COUNT(*) FROM orders GROUP BY user_id;",
    },
    {
      title: "Zero dates do not exist in PostgreSQL",
      body: "MySQL accepts '0000-00-00' as a date and many older schemas are full of them. PostgreSQL has no such value and the import will fail on the first one. Convert them to NULL before the data move, not after — and make the column nullable if it was NOT NULL DEFAULT '0000-00-00'.",
    },
    {
      title: "ON DUPLICATE KEY UPDATE becomes ON CONFLICT",
      body: "The upsert is spelled completely differently and, unlike MySQL's version, PostgreSQL requires you to name the constraint or the columns that define the conflict. That is a real improvement — MySQL's form fires on whichever unique index happens to be violated, which is ambiguous on a table with several.",
      before: "INSERT INTO t (id, n) VALUES (1, 5)\n  ON DUPLICATE KEY UPDATE n = n + 1;",
      after: "INSERT INTO t (id, n) VALUES (1, 5)\n  ON CONFLICT (id) DO UPDATE SET n = t.n + 1;",
    },
    {
      title: "Implicit type coercion stops happening",
      body: "MySQL will compare a string to a number, silently casting as it goes: WHERE id = '42' works, and so does the far worse WHERE id = '42abc'. PostgreSQL raises a type error instead. Any ORM or hand-written query that relies on coercion needs an explicit cast — and any place this was silently succeeding on garbage input is worth looking at properly.",
    },
    {
      title: "Backticks are not valid SQL anywhere else",
      body: "MySQL's backtick quoting is a MySQL invention. PostgreSQL uses double quotes, which in MySQL mean a string literal unless ANSI_QUOTES is set. This is the one thing every conversion has to fix, and it is what the translator above handles first.",
    },
  ],
  "postgresql>mysql": [
    {
      title: "You are giving up features, not just changing syntax",
      body: "This direction loses real capability: array types, custom types, table inheritance, partial indexes, expression indexes, materialised views, window function support in older MySQL, DISTINCT ON, CTEs that MySQL 5.7 cannot parse, and transactional DDL. None of that is a syntax rewrite — every one of them is a design decision to make again. It is worth being sure the migration is genuinely necessary.",
    },
    {
      title: "DISTINCT ON has no equivalent",
      body: "Postgres's DISTINCT ON is the neatest way to get the latest row per group. MySQL needs a window function (8.0+) or a self-join against a grouped subquery. The rewrite is mechanical but never as short.",
      before: "SELECT DISTINCT ON (user_id) *\nFROM orders ORDER BY user_id, created_at DESC;",
      after: "SELECT * FROM (\n  SELECT *, ROW_NUMBER() OVER (\n    PARTITION BY user_id ORDER BY created_at DESC) rn\n  FROM orders\n) t WHERE rn = 1;",
    },
    {
      title: "Arrays have to become a schema change",
      body: "A TEXT[] column has no MySQL equivalent. The options are a JSON column, which cannot be indexed or joined the same way, or a proper join table, which is usually what the data wanted in the first place. Either way this is migration work that a query translator cannot do for you.",
    },
    {
      title: "Transactional DDL goes away",
      body: "In PostgreSQL you can wrap ALTER TABLE in a transaction and roll it back. MySQL commits implicitly on DDL. Migration tooling that relies on all-or-nothing schema changes needs rethinking before the move, not after a half-applied migration in production.",
    },
    {
      title: "utf8 in MySQL is not UTF-8",
      body: "MySQL's `utf8` is a three-byte subset that cannot store emoji or many CJK characters; the real thing is `utf8mb4`. Text arriving from PostgreSQL is genuine UTF-8, so the target columns and connection must be utf8mb4 or the import will truncate or error on the first four-byte character.",
    },
  ],
  "sqlserver>postgresql": [
    {
      title: "TOP and OFFSET/FETCH are not interchangeable",
      body: "SQL Server's TOP n cannot be combined with OFFSET, so paginated T-SQL uses OFFSET … FETCH NEXT, which requires an ORDER BY. PostgreSQL's LIMIT/OFFSET has no such requirement — but a LIMIT without an ORDER BY returns an arbitrary subset in both, so any query that was relying on the mandatory ORDER BY should keep it.",
      before: "SELECT TOP 10 * FROM users ORDER BY created_at DESC;",
      after: "SELECT * FROM users ORDER BY created_at DESC LIMIT 10;",
    },
    {
      title: "Bracketed identifiers hide a case-sensitivity change",
      body: "[MyTable] in T-SQL is just quoting; SQL Server is case-insensitive by default collation. Translating it to \"MyTable\" in PostgreSQL makes it case-sensitive and permanently mixed-case. Unless you want to quote every reference forever, lowercase the identifiers instead of quoting them.",
    },
    {
      title: "Default collation is case-insensitive in one and not the other",
      body: "SQL Server's common default collation compares strings case-insensitively, so WHERE name = 'smith' matches 'Smith'. PostgreSQL is case-sensitive. Every equality comparison on text is a behaviour change — use LOWER() on both sides, or a citext column, or an expression index on LOWER(name).",
    },
    {
      title: "GETDATE() is not the same instant as NOW()",
      body: "GETDATE() returns server local time; PostgreSQL's NOW() returns a timestamptz in the session time zone. If the SQL Server was running in a non-UTC zone, converting the function without converting the stored data shifts every new row relative to the old ones.",
    },
    {
      title: "MERGE exists in both and behaves differently",
      body: "PostgreSQL gained MERGE in 15. Before that the idiom is INSERT … ON CONFLICT, which is not a general MERGE and cannot delete. Check the target version before assuming a T-SQL MERGE statement carries over.",
    },
  ],
  "postgresql>sqlserver": [
    {
      title: "Every paginated query now needs an ORDER BY",
      body: "SQL Server's OFFSET … FETCH is only valid after an ORDER BY. A PostgreSQL query using LIMIT/OFFSET without one is legal but non-deterministic, and translating it produces T-SQL that will not compile — which is arguably the database catching a bug for you.",
    },
    {
      title: "String concatenation with NULL behaves differently",
      body: "In PostgreSQL, 'a' || NULL is NULL. In SQL Server, 'a' + NULL is NULL too by default — but CONCAT() treats NULL as an empty string in both. If the original relied on || propagating NULL, using CONCAT() in the target silently changes the result.",
    },
    {
      title: "RETURNING becomes OUTPUT, with different placement",
      body: "PostgreSQL's RETURNING clause goes at the end. SQL Server's OUTPUT goes between the statement and the VALUES/FROM, and refers to the pseudo-tables `inserted` and `deleted`.",
      before: "INSERT INTO t (n) VALUES (1) RETURNING id;",
      after: "INSERT INTO t (n) OUTPUT inserted.id VALUES (1);",
    },
    {
      title: "Identifier case folding runs the other way",
      body: "PostgreSQL lowercases unquoted identifiers, so a schema migrated from it is all lowercase. SQL Server preserves whatever case it is given and compares case-insensitively under the usual collation, so this direction is the forgiving one — but a case-sensitive collation on the target will bite.",
    },
  ],
  "mysql>sqlserver": [
    {
      title: "LIMIT becomes TOP, and pagination becomes OFFSET/FETCH",
      body: "TOP n handles the simple case. The moment there is an OFFSET, T-SQL needs the OFFSET … FETCH NEXT form, which requires an ORDER BY clause. A MySQL query paginating without an ORDER BY has to acquire one.",
      before: "SELECT * FROM users LIMIT 10 OFFSET 20;",
      after: "SELECT * FROM users ORDER BY id\n  OFFSET 20 ROWS FETCH NEXT 10 ROWS ONLY;",
    },
    {
      title: "Case-insensitive comparison arrives by default",
      body: "MySQL's default collation compares case-insensitively, and so does SQL Server's — this is one of the rare pairs where that behaviour carries over. Do check the target database's collation, because a case-sensitive one (_CS_) changes the meaning of every equality on text.",
    },
    {
      title: "GROUP_CONCAT becomes STRING_AGG",
      body: "The syntax differs and so does the ordering clause: MySQL puts ORDER BY inside the function, SQL Server uses WITHIN GROUP. MySQL also truncates silently at group_concat_max_len, which defaults to 1024 bytes — a long-standing source of quietly wrong results that the migration is a good moment to notice.",
      before: "SELECT GROUP_CONCAT(name ORDER BY name SEPARATOR ', ')\nFROM users;",
      after: "SELECT STRING_AGG(name, ', ')\n  WITHIN GROUP (ORDER BY name) FROM users;",
    },
    {
      title: "No ENUM, and no ON UPDATE CURRENT_TIMESTAMP",
      body: "Both are MySQL conveniences with no T-SQL equivalent. ENUM becomes VARCHAR with a CHECK constraint; the auto-updating timestamp becomes an AFTER UPDATE trigger.",
    },
  ],
  "sqlserver>mysql": [
    {
      title: "Window functions need MySQL 8.0",
      body: "T-SQL has had window functions since 2005 and they are everywhere in real queries. MySQL only gained them in 8.0 — on 5.7 a ROW_NUMBER() OVER (…) has to be rewritten with user variables or a self-join, which is unpleasant and slow. Check the target version first; it decides how hard this migration is.",
    },
    {
      title: "CTEs and recursive CTEs need MySQL 8.0 too",
      body: "WITH … AS is not available in MySQL 5.7 at all. Any T-SQL using a CTE for readability has to be inlined as a derived table, and anything recursive has no equivalent short of application code.",
    },
    {
      title: "TOP without ORDER BY, translated, is still non-deterministic",
      body: "SELECT TOP 10 with no ORDER BY returns whatever the engine finds first, and so does LIMIT 10. The translation is faithful; the query was always unreliable.",
    },
    {
      title: "ISNULL takes two arguments, IFNULL takes two, COALESCE takes many",
      body: "ISNULL(a, b) maps to IFNULL(a, b) — but note that SQL Server's ISNULL forces the result to the first argument's type, which can silently truncate. COALESCE works identically in both and is the safer target.",
    },
  ],
  "sqlite>postgresql": [
    {
      title: "SQLite's dynamic typing means the data needs cleaning, not just the schema",
      body: "SQLite type declarations are advisory: a column declared INTEGER will store the string 'banana' without complaint. PostgreSQL enforces types strictly, so the import fails on the first value that does not match. Before migrating, run a typeof() audit on every column — the surprises are usually numbers stored as text and booleans stored inconsistently as 0/1/'true'/'yes'.",
      before: "SELECT typeof(price), COUNT(*) FROM products GROUP BY 1;",
    },
    {
      title: "There are no date or time types to migrate",
      body: "SQLite stores dates as TEXT (ISO-8601), INTEGER (Unix epoch) or REAL (Julian day), depending entirely on what the application chose. Nothing in the schema records which. You have to determine the convention per column and convert explicitly — and applications that mixed conventions in one column do exist.",
    },
    {
      title: "Concurrency changes character completely",
      body: "SQLite has a single writer at a time and locks the whole database. Code written against it often has retry-on-locked logic and avoids long transactions. PostgreSQL has MVCC and row-level locking, so that defensive code is unnecessary — and, more importantly, assumptions like \"nobody else can be writing right now\" stop holding.",
    },
    {
      title: "AUTOINCREMENT means something narrower than you think",
      body: "In SQLite, INTEGER PRIMARY KEY is already a rowid alias and auto-increments; the AUTOINCREMENT keyword only additionally prevents reuse of deleted ids. PostgreSQL's IDENTITY never reuses values either, so this maps cleanly — but a plain INTEGER PRIMARY KEY in SQLite is auto-incrementing even without the keyword, which is easy to miss when reading the source schema.",
    },
  ],
  "mysql>mariadb": [
    {
      title: "This one is mostly a no-op, and that is the honest answer",
      body: "MariaDB forked from MySQL in 2009 and remains a drop-in replacement for the overwhelming majority of queries. Standard SELECT, INSERT, UPDATE and DELETE need no changes at all. If your query is not using something recent and vendor-specific, translating it will return it essentially unchanged — which is the correct result, not a failure.",
    },
    {
      title: "Where they have actually diverged",
      body: "JSON is the big one: MySQL 5.7+ has a native binary JSON type, while MariaDB's JSON is an alias for LONGTEXT with a CHECK constraint — same functions, different storage and different performance. MariaDB has sequences, SQL:2011 system-versioned tables and RETURNING on INSERT/DELETE, none of which MySQL has. MySQL has CHECK constraint enforcement from 8.0.16, a different GTID implementation, and its own window function quirks. Replication between the two is no longer supported in either direction.",
    },
    {
      title: "Password authentication plugins differ",
      body: "MySQL 8 defaults to caching_sha2_password; MariaDB uses mysql_native_password or ed25519. This is not a query problem but it is the first thing that breaks when an application points at the other server, so it is worth knowing before you conclude the SQL is at fault.",
    },
  ],
  "db2>postgresql": [
    {
      title: "FETCH FIRST already works in PostgreSQL",
      body: "DB2's FETCH FIRST n ROWS ONLY is the SQL-standard spelling, and PostgreSQL supports it directly. Converting it to LIMIT is optional — the translator does it because LIMIT is what Postgres code usually looks like, but leaving the standard form is equally valid and more portable.",
    },
    {
      title: "The dummy table is named differently",
      body: "DB2 requires a FROM clause on every SELECT and provides SYSIBM.SYSDUMMY1 for the purpose. PostgreSQL allows a bare SELECT with no FROM at all, so those references simply disappear.",
      before: "SELECT CURRENT DATE FROM SYSIBM.SYSDUMMY1;",
      after: "SELECT CURRENT_DATE;",
    },
    {
      title: "Date arithmetic keywords differ",
      body: "DB2 writes CURRENT DATE and CURRENT TIMESTAMP as two words and supports arithmetic like `date + 1 MONTH`. PostgreSQL uses CURRENT_DATE with an underscore and interval literals: `date + INTERVAL '1 month'`.",
    },
    {
      title: "Identifiers fold to upper case, not lower",
      body: "DB2 uppercases unquoted identifiers; PostgreSQL lowercases them. A schema migrated verbatim ends up with everything renamed, which is fine as long as it happens consistently — and painful if half the code quotes identifiers and half does not.",
    },
  ],
  "mysql>bigquery": [
    {
      title: "BigQuery is analytical, and the cost model changes how you write queries",
      body: "You are billed by bytes scanned, so SELECT * on a wide table is not merely untidy — it is the difference between a free query and an expensive one. Column pruning and partition filters matter far more than index design, because there are no indexes to design. A query that was fine in MySQL can be genuinely costly here without being slow.",
    },
    {
      title: "There are no indexes, no primary keys and no foreign keys",
      body: "BigQuery enforces none of them. Performance comes from partitioning (usually by date) and clustering (by the columns you filter on), which are declared on the table rather than created alongside it. Uniqueness has to be maintained by the pipeline, not the database.",
    },
    {
      title: "Backticks mean something different here",
      body: "MySQL uses backticks to quote a column. BigQuery uses them to quote a fully-qualified table path — `project.dataset.table`. The character is the same and the meaning is not, so a mechanical find-and-replace produces valid-looking SQL that references the wrong things.",
      before: "SELECT `name` FROM `users`;",
      after: "SELECT name FROM `my-project.my_dataset.users`;",
    },
    {
      title: "UPDATE and DELETE exist, but are not for row-at-a-time work",
      body: "BigQuery supports DML, but it is designed around large batch operations and has quotas on how frequently a table can be modified. Application code that updates single rows on every request needs a different design, not a translated statement.",
    },
    {
      title: "Standard SQL only",
      body: "BigQuery's Legacy SQL used different syntax entirely. Everything here targets Standard SQL, which is the default and the only one worth writing new queries in.",
    },
  ],
  "postgresql>snowflake": [
    {
      title: "Unquoted identifiers fold up, not down",
      body: "This is the one that catches everybody. PostgreSQL lowercases unquoted identifiers; Snowflake uppercases them. A table created unquoted in Postgres as users is `users`; the same statement in Snowflake creates `USERS`. Code that then quotes \"users\" will not find it. Either quote consistently in both or never quote at all.",
    },
    {
      title: "JSONB operators do not carry over",
      body: "Postgres's ->, ->> and @> have no Snowflake equivalent. VARIANT columns use colon notation for paths and require explicit casts to get a typed value out — col:field::string rather than col->>'field'. Any query doing real JSON work needs rewriting by hand.",
      before: "SELECT data->>'email' FROM users;",
      after: "SELECT data:email::string FROM users;",
    },
    {
      title: "Constraints are metadata, not enforcement",
      body: "Snowflake accepts PRIMARY KEY, FOREIGN KEY and UNIQUE declarations and enforces none of them except NOT NULL. They exist for the optimiser and for documentation. Anything relying on the database to reject a duplicate has to move that check upstream.",
    },
    {
      title: "No indexes — and you do not need them",
      body: "There is nothing to create. Snowflake prunes micro-partitions using the clustering of the data itself, so the tuning lever is a cluster key on a large table, not an index. CREATE INDEX statements simply have no target.",
    },
  ],
  "bigquery>snowflake": [
    {
      title: "Identifier case-folding is opposite in the two engines",
      body: "BigQuery is case-sensitive for table names and case-insensitive for column names, and does not fold. Snowflake uppercases everything unquoted. The safe route is to lowercase-and-never-quote in BigQuery and let Snowflake fold, rather than carrying quoted mixed-case identifiers across.",
    },
    {
      title: "STRUCT is typed and OBJECT is not",
      body: "A BigQuery STRUCT<name STRING, age INT64> has a schema the engine enforces. Snowflake's nearest equivalent, OBJECT, is a VARIANT — untyped, checked at read time. Queries that relied on the struct's field types will still run and will start returning VARIANTs where they expected strings.",
      before: "SELECT user.name FROM events;",
      after: "SELECT user:name::string FROM events;",
    },
    {
      title: "UNNEST semantics differ",
      body: "BigQuery's UNNEST is a first-class part of its nested/repeated model and is usually written as a cross join in the FROM clause. Snowflake uses LATERAL FLATTEN, which returns a row set with metadata columns (SEQ, KEY, PATH, INDEX, VALUE) rather than the element directly.",
    },
    {
      title: "The cost model changes from bytes scanned to warehouse time",
      body: "BigQuery bills per byte scanned; Snowflake bills for how long a virtual warehouse is running. A query that was expensive in BigQuery because it touched a lot of columns may be cheap in Snowflake, and a slow query that scanned little may now be the expensive one. Optimisation priorities invert.",
    },
  ],
  "postgresql>redshift": [
    {
      title: "Redshift is Postgres 8.0.2-derived, and that is a long time ago",
      body: "The wire protocol and much of the syntax are familiar, which is exactly what makes this migration deceptive. Missing pieces include most JSON functions, many window function refinements, table inheritance, arrays, custom types, stored procedures in PL/pgSQL until relatively recently, and a great deal else. Familiar-looking SQL failing on a feature you assumed was ancient is the standard experience here.",
    },
    {
      title: "Constraints are declared and not enforced",
      body: "Redshift accepts PRIMARY KEY, FOREIGN KEY and UNIQUE and enforces none of them — the query planner uses them as hints. Data that violates a declared constraint will load without complaint, and a planner acting on a promise the data does not keep can produce wrong results, not just slow ones.",
    },
    {
      title: "Distribution and sort keys replace indexes entirely",
      body: "There is no CREATE INDEX. Performance comes from DISTKEY (which node a row lives on) and SORTKEY (the order within a slice), both declared at table creation. Getting them wrong is the main cause of slow Redshift, and neither has any counterpart in the Postgres schema you are migrating from.",
    },
    {
      title: "VARCHAR lengths are counted in bytes and enforced hard",
      body: "Postgres TEXT is unbounded. Redshift's maximum VARCHAR is 65,535 bytes — bytes, not characters, so a multibyte string fits fewer of them than you would expect. Data that was fine as TEXT can be rejected on load.",
    },
  ],
  "mysql>mongodb": [
    {
      title: "This is a data model change wearing a query converter's clothes",
      body: "Translating a SELECT into a find() or an aggregation pipeline is mechanical and Query Studio does it deterministically. But a relational schema does not become a good document schema by translation — the whole point of documents is to embed what you would otherwise join. A faithful translation of a normalised schema gives you a MongoDB database that is a slow relational database.",
    },
    {
      title: "JOIN becomes $lookup, and $lookup is not a join",
      body: "$lookup performs a left outer join into an array field on each document. It has no index-aware optimiser choosing between strategies, it materialises matched documents into the pipeline, and it is the stage most likely to make a pipeline slow. Where a relational query joins three tables, an equivalent MongoDB design usually embeds instead.",
      before: "SELECT u.name, o.total FROM users u\n  JOIN orders o ON o.user_id = u.id;",
      after: "db.users.aggregate([\n  { $lookup: { from: 'orders', localField: '_id',\n      foreignField: 'user_id', as: 'orders' } },\n  { $unwind: '$orders' }\n])",
    },
    {
      title: "There are no transactions across documents by default",
      body: "MongoDB has multi-document transactions on replica sets, but they carry real cost and are not the idiomatic pattern. Code that relied on a relational transaction spanning several tables needs either a single-document design or explicit transaction handling.",
    },
    {
      title: "NULL and missing are different things",
      body: "In SQL a column is either NULL or has a value. In MongoDB a field can be absent entirely, present-and-null, or present with a value, and queries distinguish all three. WHERE col IS NULL translates to a filter that has to decide which of those it means.",
    },
  ],
  "postgresql>mongodb": [
    {
      title: "You are giving up the things Postgres is best at",
      body: "Joins with a real optimiser, transactional integrity across tables, constraints the database enforces, and a rich type system. If the reason for moving is JSON handling, note that PostgreSQL's JSONB is genuinely good — indexable with GIN, queryable with operators, and transactional — so the move may not buy what it appears to.",
    },
    {
      title: "JSONB queries do not translate to MongoDB queries",
      body: "They look similar and are not. Postgres's @> containment operator on JSONB and MongoDB's nested field queries have different semantics for arrays and different index requirements. Anything doing real JSONB work needs rewriting rather than converting.",
    },
    {
      title: "Aggregation pipelines are ordered, and the order is the performance",
      body: "GROUP BY becomes $group, WHERE becomes $match, ORDER BY becomes $sort. What SQL leaves to the planner, a pipeline makes explicit: a $match after a $group cannot use an index, where the same predicate before it can. The translation preserves meaning; it cannot make the ordering decisions a planner would.",
    },
    {
      title: "Arrays finally have somewhere natural to go",
      body: "This is the one place the migration is a genuine simplification. A Postgres TEXT[] maps directly onto a MongoDB array field, with indexing and query operators that treat it as a first-class thing.",
    },
  ],
};

// ── What a syntax translator does not do ───────────────────────────────────

export interface Limit {
  id: string;
  title: string;
  body: string;
}

export const LIMITS: Limit[] = [
  {
    id: "procedural",
    title: "Stored procedures, functions and triggers",
    body: "Procedural code — PL/pgSQL, T-SQL procedures, MySQL routines — is a different language in every engine, with different control flow, error handling, variable declaration and transaction semantics. Query Studio translates queries, not programs. These have to be ported by hand.",
  },
  {
    id: "data",
    title: "Anything that depends on data rather than syntax",
    body: "Whether a value fits the target type, whether a date is real, whether a text column's contents are valid UTF-8 — none of that is visible in the query. A translation can be syntactically perfect and still fail on the first row of the import.",
  },
  {
    id: "vendor",
    title: "Vendor-specific extensions",
    body: "PostGIS geometry, MySQL spatial functions, SQL Server's FOR XML and hierarchyid, BigQuery's nested/repeated model, Snowflake's time travel. Where there is no equivalent concept, there is no translation — only a redesign.",
  },
  {
    id: "performance",
    title: "Performance characteristics",
    body: "A converted query is correct, not fast. Index strategy, partitioning, distribution keys and statistics differ per engine, and a query that was well-tuned for the source is merely valid on the target. Run the Analyze and Optimize tabs on the output.",
  },
  {
    id: "transactions",
    title: "Transaction and isolation semantics",
    body: "Default isolation levels, locking behaviour and whether DDL is transactional all vary. Two engines can run identical SQL and disagree about what is visible to a concurrent reader.",
  },
];

// ── Lookup ─────────────────────────────────────────────────────────────────

const INTROS: Record<string, string> = {
  "mysql>postgresql":
    "The most common migration in this list, and among the more involved. MySQL and PostgreSQL agree on the shape of a SELECT and disagree about almost everything around it — quoting, type system, strictness, and what the database will let you get away with. The syntax translation is the easy half.",
  "postgresql>mysql":
    "The less-travelled direction, and the one worth questioning before you start. Most of the work is not translation but deciding what to do about the PostgreSQL features MySQL has no answer for — arrays, custom types, partial indexes and transactional DDL among them.",
  "sqlserver>postgresql":
    "A well-worn path, usually driven by licensing. The query syntax converts cleanly; the behavioural differences — default collation, case sensitivity, and how each engine handles NULL in string operations — are what actually change results.",
  "postgresql>sqlserver":
    "Mostly a mechanical rewrite. Identifiers, row limiting and RETURNING/OUTPUT are the three things that change on nearly every query; the type system maps closely enough that the schema is rarely the hard part.",
  "mysql>sqlserver":
    "Two engines with very different syntax and surprisingly compatible semantics. Row limiting and identifier quoting change on almost every query; the default case-insensitive collation carries across, which removes the usual biggest source of behaviour drift.",
  "sqlserver>mysql":
    "How hard this is depends almost entirely on the target MySQL version. On 8.0 it is a syntax exercise. On 5.7 there are no CTEs and no window functions, and a lot of ordinary T-SQL has no direct expression at all.",
  "sqlite>postgresql":
    "The classic prototype-to-production move. The SQL itself is close to standard and converts easily; the real work is that SQLite does not enforce types, so the data arriving in PostgreSQL has to be audited rather than assumed.",
  "mysql>mariadb":
    "The most compatible pair here by a wide margin — MariaDB began as a MySQL fork and remains a drop-in replacement for ordinary queries. Translating usually returns your query nearly unchanged, and that is the right answer. The differences that do exist are in JSON storage, sequences, and features each has added since the fork.",
  "db2>postgresql":
    "DB2 is closer to the SQL standard than most, so a surprising amount carries over untouched — FETCH FIRST works in PostgreSQL as written. The changes cluster around date keywords, the dummy table, and identifier case folding running in the opposite direction.",
  "mysql>bigquery":
    "Not a like-for-like move: MySQL is a transactional row store and BigQuery is a columnar analytical warehouse. The syntax converts, but indexes, primary keys and row-at-a-time updates have no counterpart, and the billing model makes SELECT * a cost decision rather than a style one.",
  "postgresql>snowflake":
    "A common analytics migration. The SQL is close, and two things reliably cause trouble: identifiers fold to upper case rather than lower, and JSONB operators have no equivalent in Snowflake's VARIANT type.",
  "bigquery>snowflake":
    "Two cloud warehouses with similar ambitions and different foundations. Types map fairly directly; the nested-data model, the UNNEST/FLATTEN difference, and an inverted cost model are what require thought.",
  "postgresql>redshift":
    "Redshift is derived from PostgreSQL 8.0.2, which makes this migration look easier than it is. The dialect is familiar and the missing pieces are extensive — and constraints are declared but never enforced.",
  "mysql>mongodb":
    "A translation across paradigms, not dialects. Query Studio converts a SELECT into a find() or an aggregation pipeline deterministically and with no AI, which is genuinely useful for learning the mapping — but a relational schema translated document-for-table is not a good MongoDB design.",
  "postgresql>mongodb":
    "Worth being clear about the trade: you are exchanging joins, enforced constraints and a rich type system for a flexible document model. If JSON handling is the motivation, PostgreSQL's JSONB may already do what you need.",
};

/**
 * The three limits worth naming on a given pair's page, most relevant first.
 *
 * The full list belongs on the Query Studio hub, because it describes the tool
 * rather than any one conversion. Repeating all five in full on all fifteen
 * conversion pages put ~350 identical words on each of them, which is exactly
 * the boilerplate-heavy shape those pages were being rewritten to escape — it
 * measurably held their five-gram overlap up even after the pair-specific
 * content landed.
 *
 * So each page names the three that actually bite on that pair and links to
 * the full version. Which is both less duplication and better advice: the
 * transaction-semantics warning matters enormously going to MongoDB and barely
 * at all going from MySQL to MariaDB.
 */
export function limitsFor(from: string, to: string): Limit[] {
  const pick = (...ids: string[]) =>
    ids.map((id) => LIMITS.find((l) => l.id === id)!).filter(Boolean);

  // Crossing from relational to document: the semantic gap is the whole story.
  if (to === "mongodb") return pick("transactions", "procedural", "performance");
  // Analytical warehouses: performance model and vendor features dominate.
  if (["bigquery", "snowflake", "redshift"].includes(to)) return pick("performance", "vendor", "procedural");
  // A fork of the same engine: the interesting risk is the small vendor deltas.
  if (from === "mysql" && to === "mariadb") return pick("vendor", "procedural", "data");
  // SQLite's dynamic typing makes the data-shaped limit the important one.
  if (from === "sqlite") return pick("data", "procedural", "performance");
  // Everything else: the usual three.
  return pick("procedural", "data", "vendor");
}

/** Everything hand-written for this pair. Empty arrays where nothing is authored yet. */
export function pairContent(from: string, to: string): {
  intro: string | null;
  types: TypeMapping[];
  gotchas: Gotcha[];
} {
  const key = `${from}>${to}`;
  return {
    intro: INTROS[key] ?? null,
    types: TYPES[key] ?? [],
    gotchas: GOTCHAS[key] ?? [],
  };
}
