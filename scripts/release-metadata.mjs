import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

// Changesets only versions package.json; sync copies that version to the plugin
// and marketplace manifests, while check verifies those manifests and the lockfile.
export async function releaseMetadata(mode, root = process.cwd()) {
    if (!["sync", "check"].includes(mode)) {
        throw new Error("Expected release metadata mode: sync or check");
    }
    const readJson = async (path) => JSON.parse(await readFile(`${root}/${path}`, "utf8"));
    const pkg = await readJson("package.json");
    if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(pkg.version)) {
        throw new Error("package.json must contain a release version");
    }
    const plugin = await readJson("plugin.json");
    const marketplace = await readJson(".github/plugin/marketplace.json");
    const entry = marketplace.plugins.find(({ name }) => name === pkg.name);
    if (!entry || plugin.name !== pkg.name) {
        throw new Error("Plugin and marketplace names must match package.json");
    }
    if (mode === "sync") {
        plugin.version = pkg.version;
        marketplace.metadata.version = pkg.version;
        entry.version = pkg.version;
        await writeFile(`${root}/plugin.json`, `${JSON.stringify(plugin, null, 2)}\n`);
        await writeFile(`${root}/.github/plugin/marketplace.json`, `${JSON.stringify(marketplace, null, 2)}\n`);
    } else {
        const lock = await readJson("package-lock.json");
        if ([plugin.version, marketplace.metadata.version, entry.version, lock.version,
            lock.packages[""].version].some((version) => version !== pkg.version)) {
            throw new Error("Release versions differ; run npm run version:release");
        }
    }
    return pkg.version;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    await releaseMetadata(process.argv[2]);
}
