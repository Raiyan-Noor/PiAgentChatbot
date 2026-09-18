import { ConvexProvider, ConvexReactClient } from "convex/react";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./index.css";

const url = import.meta.env.VITE_CONVEX_URL as string | undefined;
const root = createRoot(document.getElementById("root")!);

if (!url) {
  root.render(
    <p className="p-8 font-mono text-sm">
      VITE_CONVEX_URL is not set. Run <b>npx convex dev</b> once (it writes .env.local), then restart.
    </p>,
  );
} else {
  const convex = new ConvexReactClient(url);
  root.render(
    <StrictMode>
      <ConvexProvider client={convex}>
        <App />
      </ConvexProvider>
    </StrictMode>,
  );
}
