// Run a Gradle task in the generated Android project, on any host OS.
//
// The wrapper is `gradlew.bat` on Windows and `./gradlew` everywhere else, and the
// package script used to hard-code the Windows one — which meant `build:android`
// could only ever run on Windows, on a project whose other half (iOS) can only be
// built on a Mac.
//
// Usage: node scripts/gradle.mjs assembleRelease
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const androidDir = join(here, "..", "android");

if (!existsSync(androidDir)) {
  console.error("[gradle] No android project. Run `npm run add:android` first.");
  process.exit(1);
}

const windows = process.platform === "win32";
const wrapper = join(androidDir, windows ? "gradlew.bat" : "gradlew");

if (!existsSync(wrapper)) {
  console.error(`[gradle] No Gradle wrapper at ${wrapper}.`);
  process.exit(1);
}

const tasks = process.argv.slice(2);
if (tasks.length === 0) tasks.push("assembleRelease");

console.log(`[gradle] ${wrapper} ${tasks.join(" ")}`);

const result = spawnSync(wrapper, tasks, { cwd: androidDir, stdio: "inherit", shell: windows });

if (result.error) {
  console.error(`[gradle] ${result.error.message}`);
  console.error("[gradle] Gradle needs a JDK on PATH and the Android SDK installed.");
  process.exit(1);
}

process.exit(result.status ?? 1);
