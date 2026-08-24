// @synatic/noql ships no type declarations. It converts SQL SELECT statements into
// MongoDB find queries or aggregation pipelines. We only use `parseSQL`, whose
// result shape is dynamic (query vs aggregate), so it's typed loosely and narrowed
// at runtime in lib/query-studio/nosql.ts.
declare module "@synatic/noql" {
  interface ParsedMongo {
    type: "query" | "aggregate";
    collection?: string | string[];
    collections?: string[];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    query?: Record<string, any>;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    projection?: Record<string, any>;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    sort?: Record<string, any>;
    limit?: number;
    skip?: number;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    pipeline?: any[];
  }
  const SQLParser: {
    parseSQL(sql: string, options?: Record<string, unknown>): ParsedMongo;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    [key: string]: any;
  };
  export default SQLParser;
}
