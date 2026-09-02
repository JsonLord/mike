// @ts-nocheck
import { localDb } from "./localDb";
import { randomUUID } from "crypto";

class QueryBuilder {
  private table: string;
  private action: "select" | "insert" | "update" | "delete" | "upsert" = "select";
  private payload: any = null;
  private filters: Array<(item: any) => boolean> = [];
  private orderRules: Array<{ col: string; ascending: boolean }> = [];
  private limitVal: number | null = null;
  private headMode = false;

  constructor(table: string) {
    this.table = table;
  }

  select(_fields?: string, options?: { count?: string; head?: boolean }) {
    if (options?.head) {
      this.headMode = true;
    }
    return this;
  }

  eq(col: string, val: any) {
    this.filters.push((item) => item && item[col] === val);
    return this;
  }

  neq(col: string, val: any) {
    this.filters.push((item) => item && item[col] !== val);
    return this;
  }

  in(col: string, vals: any[]) {
    const set = new Set(Array.isArray(vals) ? vals : []);
    this.filters.push((item) => item && set.has(item[col]));
    return this;
  }

  filter(col: string, _op: string, val: any) {
    let checkVal = val;
    if (typeof val === "string") {
      try {
        checkVal = JSON.parse(val);
      } catch {
        // Keep as string
      }
    }
    if (Array.isArray(checkVal)) {
      this.filters.push((item) => {
        if (!item || !Array.isArray(item[col])) return false;
        return checkVal.some((v) => item[col].includes(v));
      });
    } else {
      this.filters.push((item) => item && item[col] === val);
    }
    return this;
  }

  contains(col: string, val: any) {
    const checkArray = Array.isArray(val) ? val : [val];
    this.filters.push((item) => {
      if (!item || !Array.isArray(item[col])) return false;
      return checkArray.every((v) => item[col].includes(v));
    });
    return this;
  }

  order(col: string, { ascending = true }: { ascending?: boolean } = {}) {
    this.orderRules.push({ col, ascending });
    return this;
  }

  limit(n: number) {
    this.limitVal = n;
    return this;
  }

  range(_from: number, _to: number) {
    return this;
  }

  insert(data: any) {
    this.action = "insert";
    this.payload = data;
    return this;
  }

  upsert(data: any) {
    this.action = "upsert";
    this.payload = data;
    return this;
  }

  update(data: any) {
    this.action = "update";
    this.payload = data;
    return this;
  }

  delete() {
    this.action = "delete";
    return this;
  }

  async single() {
    const res = await this.execute();
    const item = Array.isArray(res.data) ? res.data[0] : res.data;
    return { data: item || null, error: null };
  }

  async maybeSingle() {
    const res = await this.execute();
    const item = Array.isArray(res.data) ? res.data[0] : res.data;
    return { data: item || null, error: null };
  }

  async execute() {
    if (this.action === "insert" || this.action === "upsert") {
      const items = Array.isArray(this.payload) ? this.payload : [this.payload];
      const saved: any[] = [];
      for (const item of items) {
        const row = { ...item };
        if (!row.id) row.id = randomUUID();
        if (!row.created_at) row.created_at = new Date().toISOString();
        if (!row.updated_at) row.updated_at = new Date().toISOString();
        const res = await localDb.upsert(this.table, row);
        saved.push(res);
      }
      const data = Array.isArray(this.payload) ? saved : saved[0];
      return { data, error: null, count: saved.length };
    }

    if (this.action === "update") {
      const items = await localDb.list<any>(this.table, (item) =>
        this.filters.every((f) => f(item)),
      );
      const updatedList: any[] = [];
      for (const item of items) {
        const updated = {
          ...item,
          ...this.payload,
          updated_at: new Date().toISOString(),
        };
        await localDb.upsert(this.table, updated);
        updatedList.push(updated);
      }
      return {
        data: updatedList.length === 1 ? updatedList[0] : updatedList,
        error: null,
        count: updatedList.length,
      };
    }

    if (this.action === "delete") {
      const items = await localDb.list<any>(this.table, (item) =>
        this.filters.every((f) => f(item)),
      );
      for (const item of items) {
        await localDb.delete(this.table, item.id);
      }
      return { data: null, error: null, count: items.length };
    }

    // Select mode
    let items = await localDb.list<any>(this.table, (item) =>
      this.filters.every((f) => f(item)),
    );

    for (const rule of this.orderRules) {
      items.sort((a, b) => {
        const valA = a[rule.col];
        const valB = b[rule.col];
        if (valA === valB) return 0;
        if (valA == null) return rule.ascending ? -1 : 1;
        if (valB == null) return rule.ascending ? 1 : -1;
        return rule.ascending ? (valA > valB ? 1 : -1) : (valA < valB ? 1 : -1);
      });
    }

    const totalCount = items.length;
    if (this.limitVal != null) {
      items = items.slice(0, this.limitVal);
    }

    return {
      data: this.headMode ? null : items,
      error: null,
      count: totalCount,
    };
  }

  then(resolve: (value: any) => void, reject?: (reason: any) => void) {
    this.execute().then(resolve, reject);
  }
}

export function createServerSupabase() {
  return {
    from: (table: string) => new QueryBuilder(table),
    auth: {
      admin: {
        listUsers: async () => ({
          data: {
            users: [
              {
                id: "00000000-0000-0000-0000-000000000000",
                email: "user@example.com",
              },
            ],
          },
          error: null,
        }),
      },
      getUser: async (_token?: string) => ({
        data: {
          user: {
            id: "00000000-0000-0000-0000-000000000000",
            email: "user@example.com",
          },
        },
        error: null,
      }),
    },
  } as any;
}

export async function getUserIdFromRequest(_req: any): Promise<string> {
  return "00000000-0000-0000-0000-000000000000";
}
