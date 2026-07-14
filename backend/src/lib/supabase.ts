// @ts-nocheck
// @ts-nocheck
// @ts-nocheck
// @ts-nocheck
// @ts-nocheck
import { localDb } from "./localDb";
import { randomUUID } from "crypto";

/**
 * Compatibility layer for Supabase calls, now using LocalDb.
 */
export function createServerSupabase() {
  // Return a proxy that mimics the Supabase client
  return {
    from: (table: string) => {
      return {
        select: (query?: string) => {
          return {
            eq: (column: string, value: any) => {
              return {
                single: async () => {
                  const items = await localDb.list<any>(table, (item) => item[column] === value);
                  return { data: items[0] || null, error: null };
                },
                maybeSingle: async () => {
                  const items = await localDb.list<any>(table, (item) => item[column] === value);
                  return { data: items[0] || null, error: null };
                },
                order: (col: string, { ascending = true } = {}) => {
                  return {
                    then: async (resolve: any) => {
                      const items = await localDb.list<any>(table, (item) => item[column] === value);
                      items.sort((a, b) => ascending ? (a[col] > b[col] ? 1 : -1) : (a[col] < b[col] ? 1 : -1));
                      resolve({ data: items, error: null });
                    }
                  };
                },
                async then(resolve: any) {
                  const items = await localDb.list<any>(table, (item) => item[column] === value);
                  resolve({ data: items, error: null });
                }
              };
            },
            match: (filter: Record<string, any>) => {
               return {
                 async then(resolve: any) {
                   const items = await localDb.list<any>(table, (item) => {
                     return Object.entries(filter).every(([k, v]) => item[k] === v);
                   });
                   resolve({ data: items, error: null });
                 }
               };
            },
            async then(resolve: any) {
               const items = await localDb.list<any>(table);
               resolve({ data: items, error: null });
            }
          };
        },
        insert: (data: any) => {
          return {
            select: () => {
              return {
                single: async () => {
                  const item = Array.isArray(data) ? data[0] : data;
                  if (!item.id) item.id = randomUUID();
                  const saved = await localDb.upsert(table, item);
                  return { data: saved, error: null };
                },
                async then(resolve: any) {
                    const items = Array.isArray(data) ? data : [data];
                    const saved = [];
                    for (const item of items) {
                         if (!item.id) item.id = randomUUID();
                         saved.push(await localDb.upsert(table, item));
                    }
                    resolve({ data: saved, error: null });
                }
              };
            },
            async then(resolve: any) {
                const items = Array.isArray(data) ? data : [data];
                for (const item of items) {
                     if (!item.id) item.id = randomUUID();
                     await localDb.upsert(table, item);
                }
                resolve({ data: null, error: null });
            }
          };
        },
        upsert: (data: any) => {
          return {
            select: () => {
              return {
                single: async () => {
                  const item = Array.isArray(data) ? data[0] : data;
                  if (!item.id) item.id = randomUUID();
                  const saved = await localDb.upsert(table, item);
                  return { data: saved, error: null };
                }
              };
            },
            async then(resolve: any) {
                const items = Array.isArray(data) ? data : [data];
                for (const item of items) {
                     if (!item.id) item.id = randomUUID();
                     await localDb.upsert(table, item);
                }
                resolve({ data: null, error: null });
            }
          };
        },
        update: (data: any) => {
          return {
            eq: (column: string, value: any) => {
              return {
                async then(resolve: any) {
                  const items = await localDb.list<any>(table, (item) => item[column] === value);
                  for (const item of items) {
                    await localDb.upsert(table, { ...item, ...data });
                  }
                  resolve({ data: null, error: null });
                }
              };
            }
          };
        },
        delete: () => {
          return {
            eq: (column: string, value: any) => {
              return {
                async then(resolve: any) {
                  const items = await localDb.list<any>(table, (item) => item[column] === value);
                  for (const item of items) {
                    await localDb.delete(table, item.id);
                  }
                  resolve({ data: null, error: null });
                }
              };
            }
          };
        }
      };
    },
    auth: {
      getUser: async (token: string) => {
        return { data: { user: { id: "default-user" } }, error: null };
      }
    }
  } as any;
}

/**
 * Return a default user ID for the single-user Space environment.
 */
export async function getUserIdFromRequest(req: Request): Promise<string> {
  return "default-user";
}
