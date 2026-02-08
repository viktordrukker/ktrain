import React from "react";
import ReactDOM from "react-dom/client";
import { MantineProvider, createTheme } from "@mantine/core";
import "@mantine/core/styles.css";
import App from "./App";
import "./styles.css";

const theme = createTheme({
  fontFamily: "\"Baloo 2\", \"Comic Sans MS\", \"Trebuchet MS\", sans-serif",
  headings: { fontFamily: "\"Baloo 2\", \"Comic Sans MS\", \"Trebuchet MS\", sans-serif" },
  defaultRadius: "md"
});

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <MantineProvider theme={theme}>
      <App />
    </MantineProvider>
  </React.StrictMode>
);
