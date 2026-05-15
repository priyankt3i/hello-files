import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./app";
import "./styles/index.css";

const storedTheme = window.localStorage.getItem("fschat-theme");
document.documentElement.dataset.theme = storedTheme === "dark" ? "dark" : "light";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
