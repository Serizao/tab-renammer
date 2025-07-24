import type { DefineAPI, SDK } from "caido:plugin";

export type API = DefineAPI<{
  // Backend minimal pour cette approche
}>;

export function init(sdk: SDK<API>) {
  sdk.console.log("🚀 Plugin Replay Tab Renamer - Backend démarré");
}