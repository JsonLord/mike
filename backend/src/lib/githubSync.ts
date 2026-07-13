import simpleGit from "simple-git";
import * as path from "path";
import * as fs from "fs/promises";

const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), "data");
const GITHUB_PAT = process.env.GITHUB_PAT;
const GITHUB_REPO = process.env.GITHUB_REPO; // e.g. "username/repo"

let gitInitiated = false;

async function initGit() {
    if (gitInitiated) return;
    if (!GITHUB_PAT || !GITHUB_REPO) {
        console.warn("GITHUB_PAT or GITHUB_REPO not set. Sync disabled.");
        return;
    }

    const git = simpleGit(DATA_DIR);

    try {
        const isRepo = await git.checkIsRepo();
        if (!isRepo) {
            await git.init();
            const remoteUrl = `https://${GITHUB_PAT}@github.com/${GITHUB_REPO}.git`;
            await git.addRemote("origin", remoteUrl);
        }
        gitInitiated = true;
    } catch (err) {
        console.error("Failed to initialize git in data directory", err);
    }
}

export async function syncToGithub() {
    if (!GITHUB_PAT || !GITHUB_REPO) return;
    await initGit();
    if (!gitInitiated) return;

    const git = simpleGit(DATA_DIR);

    try {
        await git.add(".");
        const status = await git.status();
        if (status.staged.length === 0) return;

        await git.commit(`Sync data: ${new Date().toISOString()}`);
        await git.push("origin", "main");
        console.log("Data synced to GitHub successfully.");
    } catch (err) {
        console.error("Failed to sync data to GitHub", err);
    }
}

// Debounced version of sync
let syncTimeout: NodeJS.Timeout | null = null;
export function debouncedSync() {
    if (syncTimeout) clearTimeout(syncTimeout);
    syncTimeout = setTimeout(() => {
        syncToGithub().catch(console.error);
    }, 5000); // Sync after 5 seconds of inactivity
}
