import { resolve, join } from "node:path";
import { projectPath } from "@/projectPath";

/** The launcher script local mode spawns (and `very-happy --help` asks for Claude's help). */
export const claudeCliPath = resolve(join(projectPath(), 'scripts', 'claude_local_launcher.cjs'))
