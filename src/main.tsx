import React from "react";
import ReactDOM from "react-dom/client";
import { Buffer } from "buffer";
import { ToastProvider } from "@heroui/react";

import App from "./ui/App";
import { cfg, loadConfig } from "./config";
import { initLogging, setVerbose } from "./log";
import { refreshDarkMode } from "./ui/theming";

import "./ui/styles.css";

window.Buffer = Buffer; // required for node-wav

initLogging();

await loadConfig();
await setVerbose(cfg().developerMode);

refreshDarkMode();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
    <ToastProvider placement="bottom" />
  </React.StrictMode>,
);
