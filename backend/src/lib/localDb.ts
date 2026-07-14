// @ts-nocheck
// @ts-nocheck
// @ts-nocheck
import * as fs from "fs/promises";
import * as path from "path";
import { debouncedSync } from "./githubSync";

const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), "data");

export class LocalDb {
    private static instance: LocalDb;
    private initialized = false;

    private constructor() {}

    public static getInstance(): LocalDb {
        if (!LocalDb.instance) {
            LocalDb.instance = new LocalDb();
        }
        return LocalDb.instance;
    }

    private async ensureDir(dir: string) {
        try {
            await fs.mkdir(dir, { recursive: true });
        } catch (err) {
            // Ignore if exists
        }
    }

    private async init() {
        if (this.initialized) return;
        await this.ensureDir(DATA_DIR);
        await this.ensureDir(path.join(DATA_DIR, "projects"));
        await this.ensureDir(path.join(DATA_DIR, "documents"));
        await this.ensureDir(path.join(DATA_DIR, "chats"));
        await this.ensureDir(path.join(DATA_DIR, "messages"));
        await this.ensureDir(path.join(DATA_DIR, "workflows"));
        await this.ensureDir(path.join(DATA_DIR, "user_profiles"));
        this.initialized = true;
    }

    private getPath(collection: string, id: string): string {
        return path.join(DATA_DIR, collection, `${id}.json`);
    }

    public async get<T>(collection: string, id: string): Promise<T | null> {
        await this.init();
        const filePath = this.getPath(collection, id);
        try {
            const data = await fs.readFile(filePath, "utf-8");
            return JSON.parse(data) as T;
        } catch {
            return null;
        }
    }

    public async list<T>(collection: string, filter?: (item: T) => boolean): Promise<T[]> {
        await this.init();
        const dirPath = path.join(DATA_DIR, collection);
        try {
            const files = await fs.readdir(dirPath);
            const items: T[] = [];
            for (const file of files) {
                if (file.endsWith(".json")) {
                    const data = await fs.readFile(path.join(dirPath, file), "utf-8");
                    const item = JSON.parse(data) as T;
                    if (!filter || filter(item)) {
                        items.push(item);
                    }
                }
            }
            return items;
        } catch {
            return [];
        }
    }

    public async upsert<T extends { id: string }>(collection: string, item: T): Promise<T> {
        await this.init();
        const filePath = this.getPath(collection, item.id);
        await fs.writeFile(filePath, JSON.stringify(item, null, 2), "utf-8");
        debouncedSync();
        return item;
    }

    public async delete(collection: string, id: string): Promise<void> {
        await this.init();
        const filePath = this.getPath(collection, id);
        try {
            await fs.unlink(filePath);
            debouncedSync();
        } catch {
            // Ignore if doesn't exist
        }
    }

    // Specialized methods to mimic Supabase-like queries if needed
    // or just use generic ones.
}

export const localDb = LocalDb.getInstance();
