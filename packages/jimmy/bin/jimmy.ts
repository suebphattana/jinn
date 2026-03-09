#!/usr/bin/env node
import { Command } from "commander";
import path from "node:path";
import os from "node:os";

const program = new Command();
program
  .name("jinn")
  .description("Lightweight AI gateway daemon")
  .version("0.1.0")
  .option("-i, --instance <name>", "Target a specific instance (default: jinn)");

// Pre-parse to set JINN_HOME before any module imports resolve paths
program.hook("preAction", (thisCommand) => {
  const opts = thisCommand.opts();
  if (opts.instance) {
    process.env.JINN_INSTANCE = opts.instance;
    process.env.JINN_HOME = path.join(os.homedir(), `.${opts.instance}`);
  }
});

program
  .command("setup")
  .description("Initialize Jinn and install dependencies")
  .option("--force", "Delete existing home dir and reinitialize from scratch")
  .action(async (opts) => {
    const { runSetup } = await import("../src/cli/setup.js");
    await runSetup(opts);
  });

program
  .command("start")
  .description("Start the gateway daemon")
  .option("--daemon", "Run in background")
  .action(async (opts) => {
    const { runStart } = await import("../src/cli/start.js");
    await runStart(opts);
  });

program
  .command("stop")
  .description("Stop the gateway daemon")
  .action(async () => {
    const { runStop } = await import("../src/cli/stop.js");
    await runStop();
  });

program
  .command("status")
  .description("Show gateway status")
  .action(async () => {
    const { runStatus } = await import("../src/cli/status.js");
    await runStatus();
  });

program
  .command("create <name>")
  .description("Create a new Jinn instance")
  .option("-p, --port <port>", "Set gateway port (auto-assigned if omitted)")
  .action(async (name: string, opts: { port?: string }) => {
    const { runCreate } = await import("../src/cli/create.js");
    await runCreate(name, opts.port ? parseInt(opts.port, 10) : undefined);
  });

program
  .command("list")
  .description("List all Jinn instances")
  .action(async () => {
    const { runList } = await import("../src/cli/list.js");
    await runList();
  });

program
  .command("remove <name>")
  .description("Remove a Jinn instance from the registry")
  .option("--force", "Also delete the instance home directory")
  .action(async (name: string, opts: { force?: boolean }) => {
    const { runRemove } = await import("../src/cli/remove.js");
    await runRemove(name, opts);
  });

program
  .command("chrome-allow")
  .description("Pre-approve all sites for the Claude Chrome extension")
  .option("--no-restart", "Don't restart Chrome automatically")
  .option("--comet-browser", "Target Comet browser instead of Google Chrome")
  .action(async (opts) => {
    const { runChromeAllow } = await import("../src/cli/chrome-allow.js");
    await runChromeAllow(opts);
  });

program.parse();
