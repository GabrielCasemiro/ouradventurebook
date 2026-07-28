import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { Story } from "./views/Story";
import { Home } from "./views/Home";
import "./styles.css";

const path = window.location.pathname;
const mAlbum = path.match(/^\/albuns\/([^/]+)/);
const mTrip = path.match(/^\/trip\/([^/]+)/);

let node: React.ReactNode;
if (mAlbum) node = <Story slug={decodeURIComponent(mAlbum[1])} />;
else if (mTrip) node = <App slug={decodeURIComponent(mTrip[1])} />;
else node = <Home />;

createRoot(document.getElementById("root")!).render(<React.StrictMode>{node}</React.StrictMode>);
