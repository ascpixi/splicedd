import React from "react";
import ReactDOM from "react-dom/client";
import App from "./ui/App";
import { NextUIProvider } from "@nextui-org/react";
import { loadConfig } from "./config";

import "./ui/styles.css";

import { Buffer } from "buffer";

window.Buffer = Buffer;

await loadConfig();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <NextUIProvider>
      <App />
    </NextUIProvider>
  </React.StrictMode>,
);
