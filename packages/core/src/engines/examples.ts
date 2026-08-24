// Dialect-specific example queries + schema DDL. Each dialect gets an example that
// uses its own idioms (TOP vs LIMIT vs FETCH FIRST, SERIAL vs AUTO_INCREMENT vs
// IDENTITY, boolean literals), so switching the database actually changes the sample
// — and re-running a tool produces a dialect-appropriate result.

type LimitStyle = "limit" | "top" | "fetch";

function limitStyle(id: string): LimitStyle {
  if (id === "sqlserver") return "top";
  if (id === "db2") return "fetch";
  return "limit";
}

// Databases with a real boolean type use TRUE; the rest compare against 1.
const BOOLEAN_DIALECTS = new Set(["postgresql", "duckdb", "hive", "spark", "bigquery", "snowflake", "redshift"]);

// The NoSQL dialects offered as a source (GraphQL, Elasticsearch, OpenSearch) don't
// speak SELECT — show a native example so the input box matches the real syntax.
const ES_EXAMPLE = `GET /orders/_search
{
  "size": 0,
  "query": { "range": { "created_at": { "gte": "2024-01-01" } } },
  "aggs": {
    "top_customers": {
      "terms": { "field": "customer_id", "size": 10, "order": { "total": "desc" } },
      "aggs": { "total": { "sum": { "field": "amount" } } }
    }
  }
}`;
const NOSQL_EXAMPLES: Record<string, string> = {
  elasticsearch: ES_EXAMPLE,
  opensearch: ES_EXAMPLE,
  graphql: `query TopCustomers {
  customers(first: 10, filter: { createdAfter: "2024-01-01" }, orderBy: TOTAL_SPENT_DESC) {
    name
    email
    ordersCount
    totalSpent
  }
}`,
};

export function exampleFor(dialectId: string): string {
  const nosql = NOSQL_EXAMPLES[dialectId];
  if (nosql) return nosql;

  const style = limitStyle(dialectId);
  const active = BOOLEAN_DIALECTS.has(dialectId) ? "TRUE" : "1";
  const top = style === "top" ? "TOP 10 " : "";
  const tail = style === "limit" ? "\nLIMIT 10" : style === "fetch" ? "\nFETCH FIRST 10 ROWS ONLY" : "";
  return `SELECT ${top}u.id, u.name, COUNT(o.id) AS orders
FROM users u
LEFT JOIN orders o ON o.user_id = u.id
WHERE u.created_at > '2024-01-01' AND u.active = ${active}
GROUP BY u.id, u.name
HAVING COUNT(o.id) > 3
ORDER BY orders DESC${tail};`;
}

// Dialect-appropriate auto-increment primary key + timestamp type.
function pk(dialectId: string): { id: string; ts: string } {
  switch (dialectId) {
    case "mysql":
    case "mariadb": return { id: "INT AUTO_INCREMENT PRIMARY KEY", ts: "DATETIME" };
    case "postgresql":
    case "redshift":
    case "duckdb": return { id: "SERIAL PRIMARY KEY", ts: "TIMESTAMP" };
    case "sqlserver": return { id: "INT IDENTITY(1,1) PRIMARY KEY", ts: "DATETIME2" };
    case "sqlite": return { id: "INTEGER PRIMARY KEY AUTOINCREMENT", ts: "TEXT" };
    case "bigquery": return { id: "INT64", ts: "TIMESTAMP" };
    case "snowflake": return { id: "NUMBER AUTOINCREMENT PRIMARY KEY", ts: "TIMESTAMP" };
    default: return { id: "INT PRIMARY KEY", ts: "TIMESTAMP" };
  }
}

export function ddlExampleFor(dialectId: string): string {
  const { id, ts } = pk(dialectId);
  return `CREATE TABLE users (
  id ${id},
  name VARCHAR(100) NOT NULL,
  email VARCHAR(255) NOT NULL,
  created_at ${ts}
);

CREATE TABLE orders (
  id ${id},
  user_id INT NOT NULL REFERENCES users(id),
  total DECIMAL(10,2),
  status VARCHAR(20),
  created_at ${ts}
);

CREATE TABLE order_items (
  id ${id},
  order_id INT NOT NULL REFERENCES orders(id),
  product_id INT NOT NULL,
  quantity INT
);`;
}
