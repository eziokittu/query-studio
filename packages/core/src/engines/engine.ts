// Server-side dispatcher tying the deterministic engines to a single call. Imported
// only by the API route so none of these — or their deps — reach the client.
//
// Query Studio is 100% deterministic: every result is computed locally from real
// parsers and rule engines. There is no AI, no external service and no cost.
import { runFormat } from "./formatter";
import { runValidate } from "./validator";
import { runTranslate } from "./translator";
import { runExplain } from "./explain";
import { runAnalyze } from "./analyzer";
import { runOptimize } from "./optimizer";
import { runSchema } from "./schema";
import { getDialect } from "./databases";
import { runNoSqlDeterministic } from "./nosql";
import { MAX_QUERY_LENGTH } from "./constants";
import type { StudioRequest, StudioResult } from "./types";

export { MAX_QUERY_LENGTH };

export function runStudio(req: StudioRequest): StudioResult {
  const request: StudioRequest = { ...req, query: (req.query ?? "").slice(0, MAX_QUERY_LENGTH) };

  const source = getDialect(request.source);
  const target = request.target ? getDialect(request.target) : undefined;
  const nosqlInvolved = source?.category === "NoSQL" || target?.category === "NoSQL";

  // Deterministic NoSQL paths (SQL→MongoDB, GraphQL, Elasticsearch/OpenSearch).
  if (nosqlInvolved) {
    const det = runNoSqlDeterministic(request);
    if (det) return det;
  }

  return runDeterministic(request);
}

function runDeterministic(req: StudioRequest): StudioResult {
  switch (req.action) {
    case "format":
      return runFormat(req.query, req.source, req.mode);
    case "validate":
      return runValidate(req.query, req.source);
    case "translate":
      return runTranslate(req.query, req.source, req.target ?? req.source);
    case "explain":
      return runExplain(req.query, req.source);
    case "analyze":
      return runAnalyze(req.query);
    case "optimize":
      return runOptimize(req.query);
    case "schema":
      return runSchema(req.query);
    default:
      throw new Error(`Unknown action: ${(req as StudioRequest).action}`);
  }
}
