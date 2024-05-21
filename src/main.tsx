import React from "react";
import ReactDOM from "react-dom/client";
import { NextUIProvider } from "@nextui-org/react";
import { Buffer } from "buffer";

import App from "./ui/App";
import { loadConfig } from "./config";
import { refreshDarkMode } from "./ui/theming";

import "./ui/styles.css";

window.Buffer = Buffer; // required for node-wav

await loadConfig();

refreshDarkMode();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <NextUIProvider>
      <App />
    </NextUIProvider>
  </React.StrictMode>,
);
