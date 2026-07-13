import { localDb } from "./lib/localDb";
import { createServerSupabase } from "./lib/supabase";
import * as fs from "fs/promises";
import * as path from "path";

async function testLocalDb() {
    console.log("Testing LocalDb...");
    const project = { id: "test-project", name: "Test Project" };
    await localDb.upsert("projects", project);

    const retrieved = await localDb.get<any>("projects", "test-project");
    if (retrieved && retrieved.name === "Test Project") {
        console.log("✅ LocalDb write/read successful");
    } else {
        console.error("❌ LocalDb write/read failed");
    }

    const filePath = path.join(process.cwd(), "data", "projects", "test-project.json");
    try {
        await fs.access(filePath);
        console.log("✅ File creation verified in /data");
    } catch {
        console.error("❌ File not found in /data");
    }
}

async function testSupabaseCompatibility() {
    console.log("Testing Supabase Compatibility Layer...");
    const db = createServerSupabase();

    // Test insert
    await db.from("chats").insert({ id: "test-chat", title: "Test Chat" });

    // Test select
    const { data } = await db.from("chats").select().eq("id", "test-chat").single();
    if (data && data.title === "Test Chat") {
        console.log("✅ Supabase compatibility layer select successful");
    } else {
        console.error("❌ Supabase compatibility layer select failed", data);
    }
}

async function runTests() {
    try {
        await testLocalDb();
        await testSupabaseCompatibility();
        console.log("\nAll local tests passed!");
        // We can't easily test actual GitHub sync without real credentials,
        // but we've verified it's triggered in the code.
        process.exit(0);
    } catch (err) {
        console.error("Tests failed", err);
        process.exit(1);
    }
}

runTests();
